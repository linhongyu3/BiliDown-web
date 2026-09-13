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
import os from 'node:os';
import { spawn } from 'node:child_process';
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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 开发期始终拉最新代码，避免浏览器缓存旧 JS 导致解析/功能异常
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ------------------------------------------------------------
// DASH 高清/杜比视界下载（ffmpeg 合并视频+音频轨）
// 前端携带用户 Cookie (X-Bili-Cookies) 请求，得到带高清/杜比轨的 DASH 流
// ------------------------------------------------------------
// ffmpeg 默认取项目内相对路径（可在局域网服务器上直接运行）；可用环境变量 FFMPEG_PATH 覆盖
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim()) {
    return process.env.FFMPEG_PATH.trim();
  }
  // Windows 用带 .exe 的二进制，其它平台用同名二进制
  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return path.join(ROOT, 'ffmpeg-7.0.2-essentials_build', 'bin', binName);
}
const FFMPEG_PATH = resolveFfmpeg();
const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const STREAM_REFERER = 'https://www.bilibili.com';

function httpHeaderLine(cookies) {
  let line = `Referer: ${STREAM_REFERER}\r\nUser-Agent: ${STREAM_UA}\r\n`;
  if (cookies) line += `Cookie: ${cookies}\r\n`;
  return line;
}

function pickVideo(dash, qnNum) {
  // 杜比视界视频轨通常位于 dash.dolby_vision；普通高清在 dash.video
  let pools = [];
  if (dash && dash.video) pools = pools.concat(dash.video);
  if (dash && Array.isArray(dash.dolby_vision)) pools = pools.concat(dash.dolby_vision);

  const score = (v) => {
    const c = (v.codecs || '').toLowerCase();
    if (c.startsWith('hev1') || c.startsWith('hvc1')) return 3; // HEVC/HDR
    if (c.startsWith('avc1')) return 2;
    if (c.startsWith('av01')) return 1;
    return 0;
  };

  // 优先精确匹配请求清晰度；否则取不超过它的最高可用
  let cands = pools.filter((v) => Number(v.id) === qnNum);
  if (!cands.length) cands = pools.filter((v) => Number(v.id) <= qnNum);
  if (!cands.length) cands = pools;
  cands = cands.slice().sort((a, b) => score(b) - score(a));
  return cands[0];
}

function pickAudio(dash, qnNum, preferDolby) {
  let audio = [];

  // 杜比全景声优先
  const dolbyAudio = dash && dash.dolby && Array.isArray(dash.dolby.audio) ? dash.dolby.audio : [];
  const flac = dash && dash.flac && Array.isArray(dash.flac) ? dash.flac : [];
  const base = dash && Array.isArray(dash.audio) ? dash.audio : [];

  if (preferDolby && dolbyAudio.length) audio = dolbyAudio;
  else if (flac.length) audio = flac;
  else audio = base;

  if (!audio.length) return null;
  // 选 id 最高的音频轨（通常 30280 高码 / 30216 中码 / 30232 低码）
  return audio.slice().sort((a, b) => Number(b.id) - Number(a.id))[0];
}

function jsonErr(res, msg, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: -1, message: msg }));
}

// GET /api/video/download?bvid=xx&cid=yy&qn=126&filename=xx
async function handleDashDownload(req, res, url) {
  const bvid = url.searchParams.get('bvid');
  const cid = url.searchParams.get('cid');
  const qn = Number(url.searchParams.get('qn')) || 80;
  const cookies = req.headers['x-bili-cookies'] || '';
  const filename = url.searchParams.get('filename') || 'video.mp4';

  if ((!bvid && !url.searchParams.get('aid')) || !cid) {
    return jsonErr(res, '缺少必要参数: bvid/aid 和 cid', 400);
  }
  const aid = url.searchParams.get('aid');

  try {
    // 1) 用 worker 的逻辑拉取带 WBI 签名的 DASH 播放信息（含用户 Cookie）
    const playParams = new URLSearchParams();
    if (bvid) playParams.set('bvid', bvid);
    if (aid) playParams.set('aid', aid);
    playParams.set('cid', cid);
    playParams.set('qn', String(qn));
    playParams.set('fnval', '4048'); // DASH + HDR
    playParams.set('fnver', '0');
    playParams.set('fourk', '1');

    const playReq = new Request(`http://local/api/video/playurl?${playParams.toString()}`, {
      headers: { 'X-Bili-Cookies': cookies },
    });
    const playRes = await workerModule.fetch(playReq, {}, { waitUntil() {} });
    const playJson = await playRes.json();

    const outer = playJson && playJson.data;
    const inner = (outer && outer.data) || outer; // Worker 结果 / B站 playurl 结果逐层解包
    const dash = inner && inner.dash;

    if (!dash || !dash.video) {
      return jsonErr(res, '未获取到 DASH 流（该清晰度可能需要登录或大会员），请填写 B站 Cookie 后重试');
    }

    // 2) 选轨
    const preferDolby = (dash.dolby && dash.dolby.audio && dash.dolby.audio.length > 0) && qn >= 118;
    const videoStream = pickVideo(dash, qn);
    const audioStream = pickAudio(dash, qn, preferDolby || qn >= 120);

    if (!videoStream || !videoStream.baseUrl) {
      return jsonErr(res, '未找到匹配的视频轨');
    }
    if (!audioStream || !audioStream.baseUrl) {
      return jsonErr(res, '未找到音频轨');
    }

    // 3) ffmpeg 合并（直接抓取两条 CDN 流并封装，流式输出到响应）
    const hl = httpHeaderLine(cookies);
    const args = [
      '-y', '-v', 'warning',
      '-headers', hl,
      '-i', videoStream.baseUrl,
      '-headers', hl,
      '-i', audioStream.baseUrl,
      '-c', 'copy', '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    ];
    const vc = (videoStream.codecs || '').toLowerCase();
    if (vc.startsWith('hev1') || vc.startsWith('hvc1')) args.push('-tag:v', 'hvc1');
    args.push('-f', 'mp4', 'pipe:1');

    const ffmpeg = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let ended = false;
    let headersSent = false;
    const safeName = encodeURIComponent(filename);
    ffmpeg.stderr.on('data', (d) => { process.stderr.write('[ffmpeg] ' + d); });

    ffmpeg.on('error', (e) => {
      if (ended) return;
      ended = true;
      if (!headersSent) {
        jsonErr(res, `ffmpeg 启动失败：${e.message}。（DASH 高清下载需要安装 ffmpeg，或通过环境变量 FFMPEG_PATH 指定路径）`, 500);
      } else {
        res.destroy(e);
      }
    });

    ffmpeg.on('spawn', () => {
      if (ended) return;
      headersSent = true;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename*=UTF-8''${safeName}`,
        'Cache-Control': 'no-store',
      });
      ffmpeg.stdout.pipe(res);
    });

    ffmpeg.on('close', (code) => {
      if (ended) return;
      ended = true;
      if (!headersSent) {
        // 启动成功但立即异常退出
        jsonErr(res, `ffmpeg 合并失败（exit ${code}）`, 500);
      } else {
        res.end();
      }
    });
  } catch (err) {
    jsonErr(res, '下载失败: ' + (err.message || err), 500);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // DASH 高清/杜比视界下载（需 ffmpeg，本地端处理）
    if (requestUrl.pathname === '/api/video/download') {
      await handleDashDownload(req, res, requestUrl);
      return;
    }

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bilidown 本地后端已启动: http://localhost:${PORT}`);
  console.log('按 Ctrl+C 停止');
  // 打印局域网可访问地址，方便其他设备访问
  console.log('局域网访问地址：');
  Object.values(os.networkInterfaces()).forEach((addrs) => {
    (addrs || []).forEach((a) => {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  http://${a.address}:${PORT}`);
      }
    });
  });
});