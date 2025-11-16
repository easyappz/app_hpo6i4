import instance from './axios';

export async function getHello() {
  const res = await instance.get('/api/hello/');
  return res.data;
}

export default getHello;
