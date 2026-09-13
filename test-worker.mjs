import { createHash } from 'node:crypto';

const origSubtle = globalThis.crypto.subtle;
const patchedSubtle = {
  ...origSubtle,
  async digest(algorithm, data) {
    const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
    if (name.toUpperCase() === 'MD5') {
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      return createHash('md5').update(buf).digest();
    }
    return origSubtle.digest(algorithm, data);
  },
};
Object.defineProperty(globalThis.crypto, 'subtle', { value: patchedSubtle, configurable: true });

const worker = (await import('./worker.js')).default;
const env = {};

// 测试 cookie 注入路径：带 X-Bili-Cookies 头解析视频
const biliCookie = 'buvid3=6DD8F8DC-23E9-CC05-E108-6BC56D1AF3F976347infoc; b_nut=1700000000; buvid4=EDDEBAC7-5CEF-806F-CB3A-6B646E2467EB76347-026091314-T4LELiGrHMbZmpMxCOoqbnvkostZEyJ';

const parseReq = new Request('https://x/api/parse', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Bili-Cookies': biliCookie },
  body: JSON.stringify({ url: 'BV1zuY46oE2V' }),
});
const pr = await worker.fetch(parseReq, env);
const pt = await pr.text();
const pbody = JSON.parse(pt);
console.log('=== /api/parse (with cookie) ===');
console.log('code:', pbody.code, 'message:', pbody.message);
if (pbody.data?.content) {
  console.log('title:', pbody.data.content.data?.title);
}

// 测试无 cookie（访客路径）
const popReq = new Request('https://x/api/popular?pn=1&ps=2');
const popRes = await worker.fetch(popReq, env);
const popTxt = await popRes.text();
const pop = JSON.parse(popTxt);
console.log('=== /api/popular (guest) ===');
console.log('code:', pop.code, 'message:', pop.message);

// 测试扫码登录 - 生成二维码
const createReq = new Request('https://x/api/auth/qr/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const createRes = await worker.fetch(createReq, env);
const createBody = JSON.parse(await createRes.text());
console.log('=== /api/auth/qr/create ===');
console.log('code:', createBody.code, 'message:', createBody.message);
console.log('qrcode_key:', createBody.data?.qrcode_key);
console.log('url:', createBody.data?.url);
console.log('cookies:', createBody.data?.cookies);

// 测试扫码登录 - 轮询
if (createBody.data?.qrcode_key) {
  const pollReq = new Request('https://x/api/auth/qr/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qrcode_key: createBody.data.qrcode_key, cookies: createBody.data.cookies }),
  });
  const pollRes = await worker.fetch(pollReq, env);
  const pollTxt = await pollRes.text();
  console.log('=== /api/auth/qr/poll ===');
  console.log('poll:', pollTxt);
}