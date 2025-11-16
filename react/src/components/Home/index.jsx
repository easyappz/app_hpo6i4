import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { getHello } from '../../api/hello';

const MAX_SIZE = 50 * 1024 * 1024; // 50MB
const ACCEPTED = ['mp4', 'avi', 'mov', 'webm', 'mkv'];

let ffmpegSingleton = null;
async function getFFmpeg(setLoadingText) {
  if (!ffmpegSingleton) {
    ffmpegSingleton = new FFmpeg();
    ffmpegSingleton.on('log', ({ message }) => {
      // console.log(message);
    });
    ffmpegSingleton.on('progress', ({ progress }) => {
      // handled in component via setter passed by closure
    });
    setLoadingText && setLoadingText('Загрузка ffmpeg...');
    await ffmpegSingleton.load();
  }
  return ffmpegSingleton;
}

function toHHMMSS(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${pad(h)}:${pad(m)}:${pad(ss)}`;
}

function parseTimeToSeconds(value) {
  if (!value) return 0;
  const parts = ('' + value).split(':');
  const nums = parts.map((p) => Math.max(0, Number(p || 0)));
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

function buildDownloadName(originalName) {
  const name = originalName || 'video';
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex > 0 ? name.substring(0, dotIndex) : name;
  return base + '_trim.mp4';
}

export const Home = () => {
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [apiStatus, setApiStatus] = useState('');
  const [loadingText, setLoadingText] = useState('');
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [start, setStart] = useState('00:00:00');
  const [end, setEnd] = useState('00:00:00');
  const [downloadUrl, setDownloadUrl] = useState('');

  const videoRef = useRef(null);

  useEffect(() => {
    // Fetch API hello to show connectivity
    (async () => {
      try {
        const data = await getHello();
        if (data && data.message) {
          setApiStatus(`API: ${data.message}`);
        }
      } catch (e) {
        setApiStatus('API недоступно');
      }
    })();
  }, []);

  const onFileSelect = (e) => {
    setError('');
    setDownloadUrl('');
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > MAX_SIZE) {
      setError('Файл превышает 50MB. Пожалуйста, выберите меньший файл.');
      return;
    }
    const name = f.name || '';
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (!ACCEPTED.includes(ext)) {
      setError('Поддерживаются форматы: MP4, AVI, MOV, WebM, MKV.');
      return;
    }
    setFile(f);
    setStart('00:00:00');
    setEnd('00:00:00');
  };

  const videoUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  const setStartFromCurrent = () => {
    if (!videoRef.current) return;
    const t = videoRef.current.currentTime || 0;
    setStart(toHHMMSS(t));
  };
  const setEndFromCurrent = () => {
    if (!videoRef.current) return;
    const t = videoRef.current.currentTime || 0;
    setEnd(toHHMMSS(t));
  };
  const resetTimes = () => {
    setStart('00:00:00');
    const dur = Math.floor(videoRef.current?.duration || 0);
    setEnd(dur > 0 ? toHHMMSS(dur) : '00:00:00');
  };

  const handleTrim = async () => {
    setError('');
    setDownloadUrl('');
    if (!file) {
      setError('Сначала выберите видео.');
      return;
    }
    const duration = Number(videoRef.current?.duration || 0);
    const startSec = parseTimeToSeconds(start);
    const endSec = parseTimeToSeconds(end);

    if (duration > 0 && endSec === 0) {
      // if user didn't set, consider full length
      setError('Укажите конечное время обрезки.');
      return;
    }

    if (startSec < 0 || endSec <= 0 || (duration > 0 && (startSec >= duration || endSec > Math.ceil(duration))) || startSec >= endSec) {
      setError('Неверные границы обрезки. Проверьте время начала и конца.');
      return;
    }

    setProcessing(true);
    setProgress(0);

    try {
      const ffmpeg = await getFFmpeg(setLoadingText);

      // Subscribe to progress for this run
      const onProgress = ({ progress: p }) => setProgress(Math.max(0, Math.min(1, p || 0)));
      ffmpeg.on('progress', onProgress);

      const originalName = file.name || 'input';
      const inExt = originalName.includes('.') ? originalName.split('.').pop().toLowerCase() : 'mp4';
      const inName = `input.${inExt}`;
      const outName = 'output.mp4';

      setLoadingText('Подготовка файла...');
      await ffmpeg.writeFile(inName, await fetchFile(file));

      const ss = toHHMMSS(startSec);
      const to = toHHMMSS(endSec);

      // Try fast trim (stream copy) only for MP4 inputs
      const isMp4Input = inExt === 'mp4';
      let args = [];

      if (isMp4Input) {
        args = ['-i', inName, '-ss', ss, '-to', to, '-c', 'copy', '-movflags', 'faststart', outName];
        try {
          setLoadingText('Обрезка (без перекодирования)...');
          await ffmpeg.exec(args);
        } catch (e) {
          // Fallback to re-encode if stream copy fails
          args = ['-i', inName, '-ss', ss, '-to', to, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', 'faststart', outName];
          try {
            setLoadingText('Перекодирование в MP4 (x264)...');
            await ffmpeg.exec(args);
          } catch (e2) {
            // Final fallback: mpeg4 encoder
            args = ['-i', inName, '-ss', ss, '-to', to, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', '-b:a', '128k', '-movflags', 'faststart', outName];
            setLoadingText('Перекодирование в MP4 (fallback)...');
            await ffmpeg.exec(args);
          }
        }
      } else {
        // Non-mp4 inputs: re-encode
        args = ['-i', inName, '-ss', ss, '-to', to, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', 'faststart', outName];
        try {
          setLoadingText('Перекодирование в MP4...');
          await ffmpeg.exec(args);
        } catch (e3) {
          // Fallback to mpeg4 encoder
          args = ['-i', inName, '-ss', ss, '-to', to, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', '-b:a', '128k', '-movflags', 'faststart', outName];
          setLoadingText('Перекодирование в MP4 (fallback)...');
          await ffmpeg.exec(args);
        }
      }

      setLoadingText('Формирование файла...');
      const data = await ffmpeg.readFile(outName);

      // cleanup
      try { await ffmpeg.deleteFile(inName); } catch (_) {}
      try { await ffmpeg.deleteFile(outName); } catch (_) {}

      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setLoadingText('Готово');
    } catch (e) {
      console.error(e);
      setError('Произошла ошибка при обработке видео. Попробуйте другой файл или другие параметры.');
    } finally {
      setProcessing(false);
      setProgress(0);
      setTimeout(() => setLoadingText(''), 500);
    }
  };

  const acceptAttr = useMemo(() => 'video/mp4,video/x-msvideo,video/quicktime,video/webm,video/x-matroska', []);

  return (
    <div data-easytag="id1-src/components/Home/index.jsx">
      <div className="container">
        <div className="header" style={{marginBottom: 16}}>
          <h1 style={{margin:0, fontSize: 24}}>Видеоредактор — Обрезка по времени</h1>
          <div className="badge">{apiStatus || 'Проверка API...'}</div>
        </div>

        <div className="panel" style={{padding:16}}>
          <div className="grid">
            <div>
              <label style={{display:'block', marginBottom:8}}>Загрузите видео (до 50MB):</label>
              <input className="file-input" type="file" accept={acceptAttr} onChange={onFileSelect} />
              {error ? (
                <div style={{color:'var(--danger)', marginTop:8}}>{error}</div>
              ) : null}
              {file ? (
                <div style={{color:'var(--muted)', marginTop:8}}>Файл: {file.name} • {(file.size/1024/1024).toFixed(2)} MB</div>
              ) : (
                <div className="footer-note" style={{marginTop:8}}>Поддерживаемые форматы: MP4, AVI, MOV, WebM, MKV.</div>
              )}
            </div>

            <div>
              <label style={{display:'block', marginBottom:8}}>Инструменты обрезки по времени</label>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
                <div>
                  <div style={{marginBottom:6}}>Начало (чч:мм:сс)</div>
                  <input className="time-input" value={start} onChange={(e)=>setStart(e.target.value)} placeholder="00:00:00" />
                  <div style={{display:'flex', gap:8, marginTop:8}}>
                    <button className="btn secondary" type="button" onClick={setStartFromCurrent}>Из текущего</button>
                  </div>
                </div>
                <div>
                  <div style={{marginBottom:6}}>Конец (чч:мм:сс)</div>
                  <input className="time-input" value={end} onChange={(e)=>setEnd(e.target.value)} placeholder="00:00:00" />
                  <div style={{display:'flex', gap:8, marginTop:8}}>
                    <button className="btn secondary" type="button" onClick={setEndFromCurrent}>Из текущего</button>
                  </div>
                </div>
              </div>
              <div style={{display:'flex', gap:8, marginTop:12}}>
                <button className="btn secondary" type="button" onClick={resetTimes}>Сбросить</button>
                <button className="btn" type="button" onClick={handleTrim} disabled={!file || processing}>{processing ? 'Обрезаю...' : 'Обрезать и скачать MP4'}</button>
              </div>
              {loadingText || processing ? (
                <div style={{marginTop:12}}>
                  <div style={{marginBottom:6, color:'var(--muted)'}}>{loadingText || 'Обработка...'}</div>
                  <div className="progress"><span style={{width: `${Math.round(progress*100)}%`}} /></div>
                </div>
              ) : null}
              {downloadUrl ? (
                <div style={{marginTop:12}}>
                  <a className="btn" href={downloadUrl} download={buildDownloadName(file?.name || 'video')}>Скачать результат</a>
                </div>
              ) : null}
            </div>
          </div>

          <div style={{marginTop:16}}>
            <div className="video-wrap">
              {videoUrl ? (
                <video className="video-el" ref={videoRef} src={videoUrl} controls playsInline />
              ) : (
                <div style={{padding:32, textAlign:'center', color:'var(--muted)'}}>Предпросмотр видео появится после загрузки файла.</div>
              )}
            </div>
          </div>
        </div>

        <div style={{marginTop:12}} className="footer-note">
          Советы: установите Начало и Конец с помощью кнопок «Из текущего» во время просмотра видео.
        </div>
      </div>
    </div>
  );
};

export default Home;
