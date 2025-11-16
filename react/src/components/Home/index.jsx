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

// UI sizing constants for slider overlap control
const THUMB_PX = 18; // must match CSS thumb size
const SIDE_PAD = 6;  // must match CSS .timeline padding
const HALF_THUMB = Math.round(THUMB_PX / 2);

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
  const [durationSec, setDurationSec] = useState(0);
  const [activeHandle, setActiveHandle] = useState(null); // 'start' | 'end' | null

  const videoRef = useRef(null);

  useEffect(() => {
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
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl('');
    }
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
    setDurationSec(0);
  };

  const videoUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);
  useEffect(() => () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);

  const startSec = useMemo(() => parseTimeToSeconds(start), [start]);
  const endSec = useMemo(() => parseTimeToSeconds(end), [end]);

  const startPct = useMemo(() => {
    if (!durationSec) return 0;
    const s = Math.max(0, Math.min(startSec, Math.max(0, (endSec || durationSec) - 1)));
    return (s / durationSec) * 100;
  }, [startSec, endSec, durationSec]);

  const endPct = useMemo(() => {
    if (!durationSec) return 100;
    const e = Math.max(startSec + 1, Math.min(endSec || durationSec, durationSec));
    return (e / durationSec) * 100;
  }, [startSec, endSec, durationSec]);

  // Avoid overlapping clickable areas by adding a half-thumb buffer
  const startStyleRight = useMemo(() => {
    const blockPct = Math.max(0, 100 - Math.max(0, Math.min(100, endPct)));
    return `calc(${SIDE_PAD}px + ${HALF_THUMB}px + ${blockPct}%)`;
  }, [endPct]);

  const endStyleLeft = useMemo(() => {
    const blockPct = Math.max(0, Math.min(100, startPct));
    return `calc(${SIDE_PAD}px + ${HALF_THUMB}px + ${blockPct}%)`;
  }, [startPct]);

  const setStartFromCurrent = () => {
    if (!videoRef.current) return;
    const t = Math.floor(videoRef.current.currentTime || 0);
    setStart(toHHMMSS(Math.min(t, Math.max(0, (endSec || durationSec) - 1))));
  };
  const setEndFromCurrent = () => {
    if (!videoRef.current) return;
    const t = Math.floor(videoRef.current.currentTime || 0);
    const clamp = Math.max(t, startSec + 1);
    setEnd(toHHMMSS(clamp));
  };
  const resetTimes = () => {
    setStart('00:00:00');
    const dur = Math.floor(videoRef.current?.duration || 0);
    setEnd(dur > 0 ? toHHMMSS(dur) : '00:00:00');
  };

  const handleTrim = async () => {
    setError('');
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl('');
    }
    if (!file) {
      setError('Сначала выберите видео.');
      return;
    }

    const duration = durationSec || Number(videoRef.current?.duration || 0);
    let sSec = startSec;
    let eSec = endSec;

    if (duration > 0 && eSec === 0) {
      eSec = Math.ceil(duration);
      setEnd(toHHMMSS(eSec));
    }

    if (sSec < 0 || eSec <= 0 || (duration > 0 && (sSec >= duration || eSec > Math.ceil(duration))) || sSec >= eSec) {
      setError('Неверные границы обрезки. Проверьте время начала и конца.');
      return;
    }

    const tSec = eSec - sSec;

    setProcessing(true);
    setProgress(0);

    try {
      const ffmpeg = await getFFmpeg(setLoadingText);

      const onProgress = (p) => {
        const val = typeof p?.progress === 'number' ? p.progress : (typeof p?.ratio === 'number' ? p.ratio : 0);
        setProgress(Math.max(0, Math.min(1, val)));
      };
      ffmpeg.on('progress', onProgress);

      const originalName = file.name || 'input';
      const inExt = originalName.includes('.') ? originalName.split('.').pop().toLowerCase() : 'mp4';
      const inName = `input.${inExt}`;
      const outName = 'output.mp4';

      setLoadingText('Подготовка файла...');
      await ffmpeg.writeFile(inName, await fetchFile(file));

      const ss = toHHMMSS(sSec);
      const td = toHHMMSS(tSec);

      const isMp4Input = inExt === 'mp4';
      let executed = false;

      if (isMp4Input) {
        try {
          setLoadingText('Обрезка (без перекодирования)...');
          await ffmpeg.exec(['-ss', ss, '-i', inName, '-t', td, '-avoid_negative_ts', 'make_zero', '-c', 'copy', '-movflags', '+faststart', outName]);
          executed = true;
        } catch (_) {
          executed = false;
        }
      }

      if (!executed) {
        try {
          setLoadingText('Перекодирование в MP4 (x264)...');
          await ffmpeg.exec([
            '-ss', ss, '-i', inName, '-t', td,
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            outName
          ]);
          executed = true;
        } catch (_) {
          setLoadingText('Перекодирование в MP4 (fallback)...');
          await ffmpeg.exec([
            '-ss', ss, '-i', inName, '-t', td,
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'mpeg4', '-q:v', '3',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            outName
          ]);
        }
      }

      setLoadingText('Формирование файла...');
      const data = await ffmpeg.readFile(outName);

      try { await ffmpeg.deleteFile(inName); } catch (_) {}
      try { await ffmpeg.deleteFile(outName); } catch (_) {}

      const blob = new Blob([data], { type: 'video/mp4' });
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

  // Handlers shared for onChange/onInput for better responsiveness
  const handleStartChange = (val) => {
    const clamped = Math.max(0, Math.min(Number(val), Math.max(0, (endSec || durationSec) - 1)));
    setStart(toHHMMSS(clamped));
    if (videoRef.current) videoRef.current.currentTime = clamped;
  };
  const handleEndChange = (val) => {
    const raw = Number(val);
    const clamped = Math.max(raw, startSec + 1);
    const finalV = Math.min(clamped, durationSec);
    setEnd(toHHMMSS(finalV));
    if (videoRef.current) videoRef.current.currentTime = finalV;
  };

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

              {durationSec > 0 && (
                <div style={{marginTop:12}}>
                  <div className="timeline">
                    <div
                      className="timeline__selection"
                      style={{
                        left: `${Math.max(0, Math.min(100, startPct))}%`,
                        width: `${Math.max(0, Math.min(100, endPct) - Math.max(0, Math.min(100, startPct)))}%`,
                      }}
                    />
                    {/* Start handle */}
                    <input
                      className="range range--start"
                      type="range"
                      min={0}
                      max={durationSec}
                      step={1}
                      aria-label="Начало отрезка"
                      value={Math.min(startSec, Math.max(0, (endSec || durationSec) - 1))}
                      style={{ right: startStyleRight, zIndex: activeHandle === 'start' ? 4 : 3 }}
                      onMouseDown={() => setActiveHandle('start')}
                      onTouchStart={() => setActiveHandle('start')}
                      onMouseUp={() => setActiveHandle(null)}
                      onTouchEnd={() => setActiveHandle(null)}
                      onChange={(e) => handleStartChange(e.target.value)}
                      onInput={(e) => handleStartChange(e.target.value)}
                    />
                    {/* End handle */}
                    <input
                      className="range range--end"
                      type="range"
                      min={0}
                      max={durationSec}
                      step={1}
                      aria-label="Конец отрезка"
                      value={Math.max(endSec, startSec + 1)}
                      style={{ left: endStyleLeft, zIndex: activeHandle === 'end' ? 4 : 2 }}
                      onMouseDown={() => setActiveHandle('end')}
                      onTouchStart={() => setActiveHandle('end')}
                      onMouseUp={() => setActiveHandle(null)}
                      onTouchEnd={() => setActiveHandle(null)}
                      onChange={(e) => handleEndChange(e.target.value)}
                      onInput={(e) => handleEndChange(e.target.value)}
                    />
                  </div>
                  <div style={{display:'flex', justifyContent:'space-between', color:'var(--muted)', marginTop:6, fontSize:12}}>
                    <span>{toHHMMSS(0)}</span>
                    <span>{toHHMMSS(durationSec)}</span>
                  </div>
                  <div style={{display:'flex', gap:8, marginTop:8, flexWrap:'wrap'}}>
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => {
                        const v = videoRef.current; if (!v) return; v.currentTime = parseTimeToSeconds(start); v.play();
                        const endAt = parseTimeToSeconds(end);
                        const onTime = () => { if (v.currentTime >= endAt) { v.pause(); v.removeEventListener('timeupdate', onTime); } };
                        v.addEventListener('timeupdate', onTime);
                      }}
                    >Воспроизвести выделенный отрезок</button>
                    <button className="btn secondary" type="button" onClick={() => { if (videoRef.current) videoRef.current.currentTime = parseTimeToSeconds(start); }}>К началу отрезка</button>
                    <button className="btn secondary" type="button" onClick={() => { if (videoRef.current) videoRef.current.currentTime = parseTimeToSeconds(end); }}>К концу отрезка</button>
                  </div>
                </div>
              )}

              <div style={{display:'flex', gap:8, marginTop:12, flexWrap:'wrap'}}>
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
                  <div style={{marginTop:12}}>
                    <div className="video-wrap">
                      <video className="video-el" src={downloadUrl} controls playsInline />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div style={{marginTop:16}}>
            <div className="video-wrap">
              {videoUrl ? (
                <video
                  className="video-el"
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  playsInline
                  onLoadedMetadata={() => {
                    const dur = Math.floor(videoRef.current?.duration || 0);
                    setDurationSec(dur);
                    setEnd(dur > 0 ? toHHMMSS(dur) : '00:00:00');
                  }}
                />
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
