/**
 * Bilidown - Cloudflare Workers API Proxy
 * 代理前端请求到 Bilibili API 并添加 WBI 签名
 *
 * ES Module 格式 (Cloudflare Workers 默认格式)
 */

// ============================================================
// 常量定义
// ============================================================

const API_BASE = 'https://api.bilibili.com';
const PGC_API_BASE = 'https://api.bilibili.com/pgc/view/web/season';
const PASSPORT_BASE = 'https://passport.bilibili.com';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_REFERER = 'https://www.bilibili.com';

const WBI_CACHE_TTL = 3600; // 秒 (1 小时)

// ============================================================
// 访客 Cookie (绕过 412 反爬)
// ============================================================

// B站要求请求携带真实的 buvid3 / b_nut 等 Cookie，
// 否则从数据中心 IP (Cloudflare Workers) 访问会被 B站以 412 拦截。
// 伪造的 buvid3 无法通过校验，需从 finger/spi 接口获取真实 buvid。
let guestCookies = { buvid3: null, buvid4: null };

// 从 /x/frontend/finger/spi 获取真实 buvid3/buvid4 (未登录也能获取)
async function refreshGuestCookie() {
  try {
    const resp = await fetch(`${API_BASE}/x/frontend/finger/spi`, {
      headers: { 'User-Agent': DEFAULT_UA },
    });
    if (resp.ok) {
      const body = await resp.json();
      const b3 = body?.data?.b_3;
      const b4 = body?.data?.b_4;
      if (b3) {
        guestCookies.buvid3 = b3;
        guestCookies.buvid4 = b4 || '';
      }
    }
  } catch {
    // 获取失败时保持已有值
  }
}

// 获取访客 Cookie 字符串 (首次获取真实 buvid 并缓存)
async function getGuestCookie() {
  if (!guestCookies.buvid3) {
    await refreshGuestCookie();
  }
  const now = Math.floor(Date.now() / 1000);
  const b4 = guestCookies.buvid4 ? `; buvid4=${guestCookies.buvid4}` : '';
  return `buvid3=${guestCookies.buvid3 || ''}; b_nut=${now}${b4}`;
}

// ============================================================
// WBI 签名模块
// ============================================================

// 使用 Web Crypto API 计算 MD5 (Cloudflare Workers 支持)
async function md5Hex(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('MD5', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 根据原始 key 生成 mixin_key
function getMixinKey(orig) {
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += orig[MIXIN_KEY_ENC_TAB[i]];
  }
  return result;
}

// WBI key 缓存 (全局变量)
let wbiCache = {
  imgKey: null,
  subKey: null,
  mixinKey: null,
  expiresAt: 0,
};

// 从 nav 接口获取 WBI keys
async function getWbiKeys(env, cookies) {
  const now = Math.floor(Date.now() / 1000);
  if (wbiCache.expiresAt > now && wbiCache.mixinKey) {
    return wbiCache.mixinKey;
  }

  const headers = await buildHeaders(env, cookies);
  const resp = await fetch(`${API_BASE}/x/web-interface/nav`, { headers });

  if (!resp.ok) {
    throw new Error(`获取 WBI keys 失败: HTTP ${resp.status}`);
  }

  const body = await resp.json();
  if (body.code !== 0 && body.code !== -101) {
    throw new Error(`获取 WBI keys 失败: ${body.message || '未知错误'}`);
  }

  const wbiImg = body.data?.wbi_img;
  if (!wbiImg?.img_url || !wbiImg?.sub_url) {
    throw new Error('WBI keys 响应格式异常');
  }

  const imgKey = extractKeyFromUrl(wbiImg.img_url);
  const subKey = extractKeyFromUrl(wbiImg.sub_url);

  const mixinKey = getMixinKey(imgKey + subKey);

  wbiCache = {
    imgKey,
    subKey,
    mixinKey,
    expiresAt: now + WBI_CACHE_TTL,
  };

  return mixinKey;
}

// 从 URL 中提取 key: https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png -> 7cd084941338484aae1ad9425b84077c
function extractKeyFromUrl(url) {
  const parts = url.split('/');
  const filename = parts[parts.length - 1];
  return filename.split('.')[0];
}

// 对请求参数进行 WBI 签名
async function signParams(params, env, cookies) {
  const mixinKey = await getWbiKeys(env, cookies);
  const currTime = Math.floor(Date.now() / 1000);

  const signed = { ...params, wts: currTime };

  // 过滤 value 中的特殊字符
  const chrFilter = /[!'()*]/g;
  const filtered = {};
  for (const [key, value] of Object.entries(signed)) {
    filtered[key] = String(value).replace(chrFilter, '');
  }

  // 按键名排序并编码
  const query = Object.keys(filtered)
    .sort()
    .map((key) => {
      const k = encodeURIComponent(key);
      const v = encodeURIComponent(filtered[key]);
      return `${k}=${v}`;
    })
    .join('&');

  const wbiSign = await md5Hex(query + mixinKey);

  return { ...signed, w_rid: wbiSign };
}

// ============================================================
// HTTP 请求工具
// ============================================================

async function buildHeaders(env, cookies) {
  const headers = {
    'User-Agent': env?.BILI_UA || DEFAULT_UA,
    Referer: DEFAULT_REFERER,
  };

  // 用户登录 Cookie 优先（含 SESSDATA + buvid 指纹），可从数据中心 IP 绕过 412
  if (cookies) {
    let merged = cookies;
    // 若用户 Cookie 缺少 buvid3，补充访客 buvid 指纹
    if (!/buvid3=/i.test(cookies)) {
      merged = `${await getGuestCookie()}; ${cookies}`;
    }
    headers['Cookie'] = merged;
  } else {
    // 无用户 Cookie 时使用访客 Cookie（数据中心 IP 下可能返回 412）
    headers['Cookie'] = await getGuestCookie();
  }

  const sessdata = env?.BILI_SESSDATA;
  if (sessdata && headers['Cookie'].indexOf('SESSDATA') === -1) {
    headers['Cookie'] += `; SESSDATA=${sessdata}`;
  }

  return headers;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Bili-Cookies',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonOk(data) {
  const body = JSON.stringify({ code: 0, message: 'ok', data });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function jsonError(message, code = -1, httpStatus = 200) {
  const body = JSON.stringify({ code, message });
  return new Response(body, {
    status: httpStatus,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

// 将参数对象转换为查询字符串（避免 URLSearchParams 对象重载的 TS 类型问题）
function toQueryString(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
}

async function biliFetch(path, params, env, needSign = true, cookies) {
  let finalParams = params;

  if (needSign) {
    finalParams = await signParams(params, env, cookies);
  }

  const url = `${API_BASE}${path}?${toQueryString(finalParams)}`;

  const headers = await buildHeaders(env, cookies);
  const resp = await fetch(url, { headers });
  const data = await resp.json();

  return data;
}

// ============================================================
// 链接解析模块
// ============================================================

/**
 * 解析 Bilibili 链接/ID
 * @param {string} input - 用户输入的链接或ID
 * @returns {{ type: string, id: string, raw: string } | null}
 *
 * 支持格式:
 * - BV 号: BV1xx..., bv1xx...
 * - AV 号: av123456, AV123456, 纯数字(AV号) md 注意纯数字可能是av号
 * - EP 号: ep123456, EP123456
 * - SS 号: ss123456, SS123456
 * - 完整链接: https://www.bilibili.com/video/BV1xx...
 * - 番剧链接: https://www.bilibili.com/bangumi/play/ep123456
 * - 短链接: https://b23.tv/xxxxx, b23.tv/xxxxx
 * - 【标题】+ 链接格式
 */
function parseLink(input) {
  if (!input || typeof input !== 'string') return null;

  let text = input.trim();

  // 尝试提取 【标题】中的链接
  const bracketMatch = text.match(/】\s*(.+)/);
  if (bracketMatch) {
    text = bracketMatch[1].trim();
  }

  // 1) BV 号
  const bvMatch = text.match(/(?:https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/)?(BV[1-9A-HJ-NP-Za-km-z]{10})/);
  if (bvMatch) {
    return { type: 'bv', id: bvMatch[1], raw: text };
  }

  // 2) AV 号 (纯数字也可能是 AV 号，但需要有一定长度 > 5)
  const avMatch = text.match(/(?:https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/)?[aA][vV](\d+)/);
  if (avMatch) {
    return { type: 'av', id: avMatch[1], raw: text };
  }

  // 3) 纯数字 (作为 AV 号处理)
  const numMatch = text.match(/^(\d{6,})$/);
  if (numMatch) {
    return { type: 'av', id: numMatch[1], raw: text };
  }

  // 4) EP 号 (番剧单集)
  const epMatch = text.match(/(?:https?:\/\/(?:www\.|m\.)?bilibili\.com\/bangumi\/play\/)?[eE][pP](\d+)/);
  if (epMatch) {
    return { type: 'ep', id: epMatch[1], raw: text };
  }

  // 5) SS 号 (番剧季)
  const ssMatch = text.match(/(?:https?:\/\/(?:www\.|m\.)?bilibili\.com\/bangumi\/play\/)?[sS][sS](\d+)/);
  if (ssMatch) {
    return { type: 'ss', id: ssMatch[1], raw: text };
  }

  // 6) b23.tv 短链接 (支持 http/https/无协议)
  const b23Match = text.match(/(?:https?:\/\/)?b23\.tv\/([a-zA-Z0-9]+)/);
  if (b23Match) {
    return { type: 'short', id: b23Match[1], raw: text };
  }

  // 7) 完整番剧链接 (包含 play 但没有明确 ep/ss 前缀)
  const bangumiMatch = text.match(/bangumi\/play\/(?:ss|ep)?(\d+)/i);
  if (bangumiMatch) {
    return { type: 'ep', id: bangumiMatch[1], raw: text };
  }

  return null;
}

/**
 * 解析短链接 (跟随 302 重定向)
 */
async function resolveShortUrl(shortCode) {
  const url = `https://b23.tv/${shortCode}`;
  // 使用 GET 而不是 HEAD，b23.tv 对 HEAD 请求可能返回不同结果
  const resp = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'User-Agent': DEFAULT_UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
  });

  let location = resp.headers.get('location');
  if (!location) {
    // 如果没有 Location header，尝试从 HTML body 中提取
    const text = await resp.text();
    const metaMatch = text.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^;]*;url=([^"']+)["']/i);
    if (metaMatch) {
      location = metaMatch[1];
    }
  }
  if (!location) {
    // 尝试从 JS 跳转中提取
    const text2 = await resp.text().catch(() => '');
    const jsMatch = text2.match(/window\.location\.href\s*=\s*["']([^"']+)["']/);
    if (jsMatch) location = jsMatch[1];
  }

  if (!location) {
    throw new Error('短链接解析失败: 无法获取重定向地址');
  }

  // 处理相对路径
  if (location.startsWith('/')) {
    location = 'https://b23.tv' + location;
  }

  return location;
}

/**
 * 根据解析结果获取视频/番剧信息
 */
async function fetchContentInfo(parseResult, env, cookies) {
  const { type, id } = parseResult;

  switch (type) {
    case 'bv': {
      const params = { bvid: id };
      const data = await biliFetch('/x/web-interface/view', params, env, true, cookies);
      if (data.code !== 0) {
        throw new Error(`获取视频信息失败: ${data.message || '未知错误'}`);
      }
      return { type: 'video', data: data.data };
    }

    case 'av': {
      const params = { aid: id };
      const data = await biliFetch('/x/web-interface/view', params, env, true, cookies);
      if (data.code !== 0) {
        throw new Error(`获取视频信息失败: ${data.message || '未知错误'}`);
      }
      return { type: 'video', data: data.data };
    }

    case 'ep': {
      const params = { ep_id: id };
      const headers = await buildHeaders(env, cookies);
      const resp = await fetch(`${PGC_API_BASE}?${toQueryString(params)}`, {
        headers,
      });
      const data = await resp.json();
      if (data.code !== 0) {
        throw new Error(`获取番剧信息失败: ${data.message || '未知错误'}`);
      }
      return { type: 'season', data: data.result };
    }

    case 'ss': {
      const params = { season_id: id };
      const headers = await buildHeaders(env, cookies);
      const resp = await fetch(`${PGC_API_BASE}?${toQueryString(params)}`, {
        headers,
      });
      const data = await resp.json();
      if (data.code !== 0) {
        throw new Error(`获取番剧信息失败: ${data.message || '未知错误'}`);
      }
      return { type: 'season', data: data.result };
    }

    case 'short': {
      // 先解析短链接获取真实 URL，再递归解析
      const resolvedUrl = await resolveShortUrl(id);
      const subResult = parseLink(resolvedUrl);
      if (!subResult) {
        throw new Error(`无法解析短链接指向的内容: ${resolvedUrl}`);
      }
      return fetchContentInfo(subResult, env, cookies);
    }

    default:
      throw new Error('不支持的链接类型');
  }
}

// ============================================================
// 路由处理函数
// ============================================================

/**
 * POST /api/parse
 * 解析链接，返回视频/番剧信息
 */
async function handleParse(request, env, cookies) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('请求体必须是 JSON 格式');
  }

  const url = body.url || body.link || body.text || '';
  if (!url) {
    return jsonError('缺少 url/link/text 参数');
  }

  const parsed = parseLink(url);
  if (!parsed) {
    return jsonError('无法解析该链接，请提供有效的 Bilibili 链接或 ID');
  }

  try {
    const info = await fetchContentInfo(parsed, env, cookies);
    return jsonOk({
      parsed: parsed,
      content: info,
    });
  } catch (err) {
    return jsonError(err.message);
  }
}

/**
 * GET /api/video/info?bvid=xxx
 */
async function handleVideoInfo(url, env, cookies) {
  const bvid = url.searchParams.get('bvid');
  const aid = url.searchParams.get('aid');

  if (!bvid && !aid) {
    return jsonError('缺少 bvid 或 aid 参数');
  }

  const params = {};
  if (bvid) params.bvid = bvid;
  if (aid) params.aid = aid;

  const data = await biliFetch('/x/web-interface/view', params, env, true, cookies);
  return jsonOk(data);
}

/**
 * GET /api/video/playurl?bvid=xxx&cid=xxx
 * 获取视频播放地址 (WBI 签名)
 */
async function handlePlayurl(url, env, cookies) {
  const bvid = url.searchParams.get('bvid');
  const cid = url.searchParams.get('cid');
  const aid = url.searchParams.get('aid');
  const qn = url.searchParams.get('qn') || '80'; // 默认 80
  const fnval = url.searchParams.get('fnval') || '4048'; // DASH + HDR

  if ((!bvid && !aid) || !cid) {
    return jsonError('缺少必要参数: bvid/aid 和 cid');
  }

  const params = { cid, qn, fnval, fourk: '1' };
  if (bvid) params.bvid = bvid;
  if (aid) params.aid = aid;

  const data = await biliFetch('/x/player/wbi/playurl', params, env, true, cookies);
  return jsonOk(data);
}

/**
 * GET /api/popular
 * 获取热门视频
 */
async function handlePopular(url, env, cookies) {
  const pn = url.searchParams.get('pn') || '1';
  const ps = url.searchParams.get('ps') || '30';

  const params = { pn, ps };
  const data = await biliFetch('/x/web-interface/popular', params, env, true, cookies);
  return jsonOk(data);
}

/**
 * GET /api/season/info?epid=xxx&ssid=xxx
 * 获取番剧信息
 */
async function handleSeasonInfo(url, env, cookies) {
  const epid = url.searchParams.get('epid');
  const ssid = url.searchParams.get('ssid');

  if (!epid && !ssid) {
    return jsonError('缺少 epid 或 ssid 参数');
  }

  const params = {};
  if (epid) params.ep_id = epid;
  if (ssid) params.season_id = ssid;

  const headers = await buildHeaders(env, cookies);
  const resp = await fetch(`${PGC_API_BASE}?${toQueryString(params)}`, {
    headers,
  });
  const data = await resp.json();
  return jsonOk(data);
}

/**
 * GET /api/search?keyword=xxx
 */
async function handleSearch(url, env, cookies) {
  const keyword = url.searchParams.get('keyword');
  const searchType = url.searchParams.get('type') || 'video';
  const pn = url.searchParams.get('pn') || '1';

  if (!keyword) {
    return jsonError('缺少 keyword 参数');
  }

  const params = {
    search_type: searchType,
    keyword,
    page: pn,
  };

  const data = await biliFetch('/x/web-interface/search/type', params, env, true, cookies);
  return jsonOk(data);
}

/**
 * POST /api/resolve
 * 短链接解析 + 返回信息
 */
async function handleResolve(request, env, cookies) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('请求体必须是 JSON 格式');
  }

  const url = body.url || body.link || '';
  if (!url) {
    return jsonError('缺少 url/link 参数');
  }

  // 只处理短链接
  const parsed = parseLink(url);
  if (!parsed) {
    return jsonError('无法解析该链接');
  }

  try {
    let resolvedUrl = null;
    if (parsed.type === 'short') {
      resolvedUrl = await resolveShortUrl(parsed.id);
      // 用解析后的 URL 重新获取信息
      const subParsed = parseLink(resolvedUrl);
      if (subParsed) {
        const info = await fetchContentInfo(subParsed, env, cookies);
        return jsonOk({
          original: url,
          resolved_url: resolvedUrl,
          parsed: subParsed,
          content: info,
        });
      }
    }

    // 非短链接直接获取信息
    const info = await fetchContentInfo(parsed, env, cookies);
    return jsonOk({
      original: url,
      resolved_url: resolvedUrl,
      parsed,
      content: info,
    });
  } catch (err) {
    return jsonError(err.message);
  }
}

/**
 * GET /api/download?bvid=xxx&cid=xxx
 * 获取下载地址
 */
async function handleDownload(url, env, cookies) {
  const bvid = url.searchParams.get('bvid');
  const cid = url.searchParams.get('cid');
  const aid = url.searchParams.get('aid');

  if ((!bvid && !aid) || !cid) {
    return jsonError('缺少必要参数: bvid/aid 和 cid');
  }

  const params = {
    cid,
    qn: '120',       // 最高画质(4K)
    fnval: '4048',   // DASH + HDR
    fourk: '1',
    fnver: '0',
    otype: 'json',
  };
  if (bvid) params.bvid = bvid;
  if (aid) params.aid = aid;

  const data = await biliFetch('/x/player/wbi/playurl', params, env, true, cookies);
  return jsonOk(data);
}

/**
 * GET /api/video/stream?bvid=xxx&cid=xxx&qn=64
 * 代理视频流，绕过浏览器 CORS/ORB 拦截及 B站防盗链。
 * 前端把 bvid/cid/qn 传进来，后端取播放地址后转发视频字节流（带 Referer）。
 */
async function handleVideoStream(request, url, env, cookies) {
  const bvid = url.searchParams.get('bvid');
  const cid = url.searchParams.get('cid');
  const qn = url.searchParams.get('qn') || '64';
  const aid = url.searchParams.get('aid');
  // 可选：前端已解析好的直链。直接代理它，避免二次换质（媒体元素无法携带 X-Bili-Cookies）
  const directUrl = url.searchParams.get('url');

  if (!directUrl && (!bvid && !aid)) {
    return jsonError('缺视频地址，提供 bvid/aid+ cid 或 url 参数');
  }

  let streamUrl = directUrl;
  if (!streamUrl) {
    const params = { cid, qn, fnval: '0', fourk: '1' };
    if (bvid) params.bvid = bvid;
    if (aid) params.aid = aid;
    const playData = await biliFetch('/x/player/wbi/playurl', params, env, true, cookies);
    const inner = playData?.data || playData;
    const durl = inner?.durl;
    streamUrl = (durl && durl[0] && durl[0].url) || '';
  }

  if (!streamUrl) {
    return jsonError('无法获取视频流地址');
  }

  // 转发视频流。必须透传浏览器的 Range 请求头，并透传上游 206 状态，
  // 否则播放器无法建立播放与拖动进度。
  const headers = await buildHeaders(env, cookies);
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  const upstream = await fetch(streamUrl, { headers });

  const responseHeaders = {
    ...corsHeaders(),
    'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
  };

  // 透传 206 相关头，保证分段传输与拖动进度正确
  const passThrough = ['content-length', 'accept-ranges', 'content-range'];
  for (const h of passThrough) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders[h] = v;
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
    statusText: upstream.statusText,
  });
}

/**
 * GET /api/fav/list?id=xxx
 * 获取收藏夹内容
 */
async function handleFavList(url, env, cookies) {
  const mediaId = url.searchParams.get('id');
  const pn = url.searchParams.get('pn') || '1';
  const ps = url.searchParams.get('ps') || '20';

  if (!mediaId) {
    return jsonError('缺少 id 参数 (收藏夹 media_id)');
  }

  const params = {
    media_id: mediaId,
    pn,
    ps,
    platform: 'web',
  };

  const data = await biliFetch('/x/v3/fav/resource/list', params, env, true, cookies);
  return jsonOk(data);
}

// ============================================================
// B站扫码登录 (解决数据中心 IP 被 B站风控拦截的 412 问题)
// ============================================================

// 从 Response 提取所有 Set-Cookie，序列化为 "name=value; " 字符串
function extractCookiesFromSetCookie(resp) {
  const getSetCookie = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie.call(resp.headers)
    : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
  const map = {}; // 按 name 去重，保留最后值
  for (const sc of getSetCookie || []) {
    const pair = sc.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > 0) {
      map[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return Object.keys(map).map((k) => k + '=' + map[k]).join('; ');
}

/**
 * POST /api/auth/qr/create
 * 生成扫码登录二维码
 */
async function handleQrCreate() {
  try {
    const resp = await fetch(`${PASSPORT_BASE}/x/passport-login/web/qrcode/generate`, {
      headers: { 'User-Agent': DEFAULT_UA, 'Referer': DEFAULT_REFERER },
    });
    const body = await resp.json();
    if (body.code !== 0) {
      return jsonError(`生成二维码失败: ${body.message || '未知错误'}`);
    }
    const data = body.data || {};
    // url 中的 \u0026 是 & 的 unicode 转义，需还原
    const loginUrl = String(data.url || '').replace(/\\u0026/g, '&');
    return jsonOk({
      qrcode_key: data.qrcode_key || '',
      url: loginUrl,
      // 生成过程中 B站可能下发 buvid 等 cookie，转交前端，轮询时带回保持一致
      cookies: extractCookiesFromSetCookie(resp),
    });
  } catch (err) {
    return jsonError('生成二维码失败: ' + err.message);
  }
}

/**
 * POST /api/auth/qr/poll
 * 轮询扫码状态；登录成功(data.code===0)时提取 SESSDATA 等 Cookie
 */
async function handleQrPoll(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('请求体必须是 JSON 格式');
  }
  const key = body.qrcode_key || '';
  if (!key) {
    return jsonError('缺少 qrcode_key 参数');
  }

  try {
    const headers = { 'User-Agent': DEFAULT_UA, 'Referer': DEFAULT_REFERER };
    const authCookies = body.cookies || '';
    if (authCookies) headers['Cookie'] = authCookies;

    const resp = await fetch(
      `${PASSPORT_BASE}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
      { headers }
    );
    const json = await resp.json();
    const d = json.data || {};

    let cookies = '';
    if (d.code === 0) {
      cookies = extractCookiesFromSetCookie(resp);
    }

    return jsonOk({
      code: d.code,            // 86101未扫码 86090已扫码待确认 86038已失效 0成功
      message: d.message || '',
      url: d.url || '',
      cookies,
    });
  } catch (err) {
    return jsonError('轮询失败: ' + err.message);
  }
}

/**
 * GET /api/ping
 * 连通性测试
 */
function handlePing() {
  return jsonOk({ status: 'pong' });
}

/**
 * GET /api/image?url=xxx
 * 图片代理，绕过 B站防盗链
 */
async function handleImageProxy(url) {
  const imgUrl = url.searchParams.get('url');
  if (!imgUrl) {
    return jsonError('缺少 url 参数');
  }

  // 只允许代理 B站域名的图片，防止滥用
  const allowedHosts = [
    'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com',
    'i0.biliimg.com', 'i1.biliimg.com', 'i2.biliimg.com',
    's1.hdslb.com', 's2.hdslb.com',
    'archive.bilibili.com',
    'p0.hdslb.com', 'p1.hdslb.com',
    'face.bilibili.com',
  ];

  try {
    const imgHost = new URL(imgUrl).hostname;
    const isAllowed = allowedHosts.some(h => imgHost === h || imgHost.endsWith('.' + h) || imgHost.endsWith('.hdslb.com') || imgHost.endsWith('.biliimg.com'));
    if (!isAllowed) {
      return jsonError('不支持代理该域名的图片');
    }
  } catch {
    return jsonError('无效的图片 URL');
  }

  try {
    const resp = await fetch(imgUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://www.bilibili.com/',
      },
    });

    if (!resp.ok) {
      return new Response('Image fetch failed: ' + resp.status, {
        status: resp.status,
        headers: corsHeaders(),
      });
    }

    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const body = await resp.arrayBuffer();

    // 添加缓存头，减少重复请求
    return new Response(body, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    return jsonError('图片代理失败: ' + err.message);
  }
}

// ============================================================
// 主入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    try {
      // 用户登录 Cookie：由前端传入，用于绕过 B站对数据中心 IP 的 412 拦截
      const cookies = request.headers.get('X-Bili-Cookies') || '';

      switch (path) {
        // 连通性测试
        case '/api/ping':
          return handlePing();

        // 图片代理 (绕过B站防盗链)
        case '/api/image':
          return await handleImageProxy(url);

        // 链接解析 (POST)
        case '/api/parse':
          if (request.method !== 'POST') {
            return jsonError('仅支持 POST 方法', -1, 405);
          }
          return await handleParse(request, env, cookies);

        // 视频信息
        case '/api/video/info':
          return await handleVideoInfo(url, env, cookies);

        // 播放地址 (WBI 签名)
        case '/api/video/playurl':
          return await handlePlayurl(url, env, cookies);

        // 视频流代理 (绕过 CORS/防盗链)
        case '/api/video/stream':
          return await handleVideoStream(request, url, env, cookies);

        // 热门视频
        case '/api/popular':
          return await handlePopular(url, env, cookies);

        // 番剧信息
        case '/api/season/info':
          return await handleSeasonInfo(url, env, cookies);

        // 搜索
        case '/api/search':
          return await handleSearch(url, env, cookies);

        // 短链接解析 (POST)
        case '/api/resolve':
          if (request.method !== 'POST') {
            return jsonError('仅支持 POST 方法', -1, 405);
          }
          return await handleResolve(request, env, cookies);

        // 下载地址
        case '/api/download':
          return await handleDownload(url, env, cookies);

        // 收藏夹
        case '/api/fav/list':
          return await handleFavList(url, env, cookies);

        // 扫码登录 - 生成二维码 (POST)
        case '/api/auth/qr/create':
          if (request.method !== 'POST') {
            return jsonError('仅支持 POST 方法', -1, 405);
          }
          return await handleQrCreate();

        // 扫码登录 - 轮询状态 (POST)
        case '/api/auth/qr/poll':
          if (request.method !== 'POST') {
            return jsonError('仅支持 POST 方法', -1, 405);
          }
          return await handleQrPoll(request);

        // 未知路由
        default:
          return jsonError(`未知路由: ${path}`, 404);
      }
    } catch (err) {
      console.error(`[ERROR] ${path}:`, err.message, err.stack);
      return jsonError(`服务器内部错误: ${err.message}`, -1, 500);
    }
  },
};