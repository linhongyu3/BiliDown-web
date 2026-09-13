/**
 * Bilidown 本地后端
 * 在 localhost:2233 运行 worker.js 的 fetch handler。
 *
 * 为什么需要：Cloudflare 数据中心 IP 与第三方 Origin 均被 B站风控，
 * 只有国内宽带等放行网络能直连 B站。本地后端即可正常解析 + 扫码登录。
 *
 * 依赖：Node.js >= 19 (全局 fetch / Request / Response / crypto / URL)
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import workerModule from './worker.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ------------------------------------------------------------
// MD5 补丁：Node WebCrypto 不支持 'MD5'，委托给 node:crypto
// ------------------------------------------------------------
const nativeSubtle = globalThis.crypto.subtle;
if (nativeSubtle && typeof nativeSubtle.digest === 'function') {
  const origDigest = nativeSubtle.digest.bind(nativeSubtle);
  nativeSubtle.digest = async function (algorithm, data) {
    const name = (typeof algorithm === 'string' ? algorithm : algorithm?.name || '').toUpperCase();
    if (name === 'MD5') {
      const buf = data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length));
      return createHash('md5').update(buf).digest();
    }
    return origDigest(algorithm, data);
  };
}

const PORT = Number(process.env.PORT) || 2233;

// 将 IncomingMessage 转成 worker 可用的 Request
async function toWorkerRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }

  const init = { method: req.method, headers };

  // 读取请求体
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (raw.length > 0) {
    init.body = new Uint8Array(raw);
  }

  return new Request(url.href, init);
}

// 托管前端静态文件 (index.html / css / js / 图片等)
async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let urlPath = url.pathname;
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(urlPath)));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // API 请求交给 Worker handler；其余托管前端静态文件
    if (requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/')) {
      const workerReq = await toWorkerRequest(req);
      const workerRes = await workerModule.fetch(workerReq, {}, { waitUntil() {} });

      const headers = {};
      workerRes.headers.forEach((v, k) => {
        if (k.toLowerCase() === 'set-cookie') {
          if (!headers[k]) headers[k] = [];
          headers[k].push(v);
        } else {
          headers[k] = v;
        }
      });

      res.writeHead(workerRes.status, headers);

      // 流式转发响应体，避免大视频整片缓冲到内存
      if (workerRes.body) {
        const reader = workerRes.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) res.write(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
      return;
    }

    await serveStatic(req, res);
  } catch (err) {
    console.error('[server][ERROR]', err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: -1, message: '本地后端错误: ' + (err.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Bilidown 本地后端已启动: http://localhost:${PORT}`);
  console.log('按 Ctrl+C 停止');
});