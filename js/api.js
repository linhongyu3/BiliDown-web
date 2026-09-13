/**
 * Bilidown - API 请求封装
 * 通过 Cloudflare Workers 代理调用 B站 API
 * ES5 兼容，无外部依赖
 */

;(function(global) {
  'use strict';

  // ============================================================
  // 内部工具函数
  // ============================================================

  /**
   * 发起带超时的 fetch 请求
   * @param {string} url - 请求地址
   * @param {object} options - fetch 选项
   * @param {number} timeout - 超时毫秒数（默认10000）
   * @returns {Promise}
   */
  function request(url, options, timeout) {
    timeout = timeout || 10000;

    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        reject(new Error('\u8bf7\u6c42\u8d85\u65f6')); // 请求超时
      }, timeout);

      var fetchOptions = options || {};
      fetchOptions.headers = fetchOptions.headers || {};
      fetchOptions.headers['Content-Type'] = fetchOptions.headers['Content-Type'] || 'application/json';

      // 附加用户 B站 Cookie，用于让后端绕过 B站对数据中心 IP 的 412 拦截
      var biliCookies = global.BILIDOWN_BIli_COOKIES || '';
      try {
        biliCookies = biliCookies || (global.localStorage.getItem('bilidown_cookies') || '');
      } catch (e) {}
      if (biliCookies) {
        fetchOptions.headers['X-Bili-Cookies'] = biliCookies;
      }

      fetch(url, fetchOptions).then(function(response) {
        clearTimeout(timer);
        if (!response.ok) {
          reject(new Error('HTTP ' + response.status + ': ' + response.statusText));
          return;
        }
        return response.json();
      }).then(function(json) {
        resolve(json);
      }).catch(function(err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * 获取 Worker 基础地址
   */
  function getBaseUrl() {
    return global.BILIDOWN_API_URL || '';
  }

  /**
   * 构建完整 API URL
   */
  function buildUrl(path, params) {
    var base = getBaseUrl().replace(/\/+$/, '');
    var url = base + path;

    if (params) {
      var qs = [];
      for (var key in params) {
        if (params.hasOwnProperty(key) && params[key] !== undefined && params[key] !== null) {
          qs.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
        }
      }
      if (qs.length > 0) {
        url += '?' + qs.join('&');
      }
    }

    return url;
  }

  /**
   * 标准化视频信息字段
   * B站 API 返回的字段与前端使用的字段名不同，做映射
   */
  function normalizeVideoInfo(data) {
    if (!data) return null;

    var info = {};

    // 基本信息
    info.bvid = data.bvid || data.bvid || '';
    info.aid = data.aid || 0;
    info.title = data.title || '';
    info.desc = data.desc || data.description || '';

    // 封面: B站返回 pic 或 cover
    info.cover = data.pic || data.cover || '';

    // 作者信息映射: owner.name -> author
    if (data.owner) {
      info.author = data.owner.name || '';
      info.authorMid = data.owner.mid || 0;
      info.authorFace = data.owner.face || '';
    } else {
      info.author = data.author || data.name || '';
      info.authorMid = data.mid || data.author_mid || 0;
      info.authorFace = data.face || data.author_face || '';
    }

    // 统计信息
    info.view = data.stat ? data.stat.view : (data.view || 0);
    info.like = data.stat ? data.stat.like : (data.like || 0);
    info.coin = data.stat ? data.stat.coin : (data.coin || 0);
    info.favorite = data.stat ? data.stat.favorite : (data.fav || data.favorite || 0);
    info.danmaku = data.stat ? data.stat.danmaku : (data.danmaku || data.danmu || 0);
    info.reply = data.stat ? data.stat.reply : (data.reply || 0);
    info.share = data.stat ? data.stat.share : (data.share || 0);

    // 时长 (秒)
    info.duration = data.duration || 0;

    // 发布时间
    info.pubdate = data.pubdate || data.pub_date || data.ctime || 0;

    // 分P信息
    info.pages = data.pages || data.videos || [];

    // 视频分类
    info.tname = data.tname || data.type_name || '';
    info.tid = data.tid || 0;

    // 额外原始数据 (可能有用)
    info._raw = data;

    return info;
  }

  /**
   * 标准化播放信息
   */
  function normalizePlayInfo(data) {
    if (!data) return null;

    var info = {};

    info.url = data.url || '';
    info.durl = data.durl || [];
    info.acceptQuality = data.accept_quality || data.accept_format || [];
    info.acceptDescription = data.accept_description || [];
    info.quality = data.quality || data.current_quality || 0;
    info.format = data.format || '';
    info.dash = data.dash || null;

    // 如果 durl 是数组，把单个 URL 提取出来 (durl: [{url, ...}])
    if (!info.url && info.durl && info.durl.length > 0) {
      var firstUrl = typeof info.durl[0] === 'string' ? info.durl[0] : (info.durl[0] && info.durl[0].url) || '';
      info.url = firstUrl;
    }

    // 清晰度列表
    info.qualities = [];
    if (info.acceptDescription && info.acceptDescription.length > 0) {
      for (var i = 0; i < info.acceptDescription.length; i++) {
        info.qualities.push({
          qn: info.acceptQuality[i] || 0,
          desc: info.acceptDescription[i] || ''
        });
      }
    }

    return info;
  }

  /**
   * 标准化搜索结果
   */
  function normalizeSearchResult(data) {
    if (!data) return { videos: [], total: 0 };

    var result = {
      total: data.numResults || data.total || data.numRes || 0,
      pages: data.numPages || data.pages || 1,
      videos: []
    };

    var list = data.result || data.results || data.videos || [];
    if (list.length > 0) {
      for (var i = 0; i < list.length; i++) {
        result.videos.push(normalizeVideoInfo(list[i]));
      }
    }

    return result;
  }

  // ============================================================
  // 请求包装: 统一的错误处理和标准化
  // ============================================================

  /**
   * 执行 API 请求并统一处理响应
   * 始终返回 {code, message, data} 格式
   */
  function apiCall(method, path, params, body, timeout) {
    var url = buildUrl(path, params);
    var options = {};

    if (method === 'POST') {
      options.method = 'POST';
      options.body = JSON.stringify(body || {});
    }

    return request(url, options, timeout).then(function(resp) {
      if (resp && resp.code === 0) {
        // 成功：统一返回格式
        return {
          code: 0,
          message: resp.message || 'ok',
          data: resp.data !== undefined ? resp.data : null
        };
      }
      // 业务错误
      var errMsg = resp && resp.message ? resp.message : '\u672a\u77e5\u9519\u8bef'; // 未知错误
      return {
        code: resp && resp.code !== undefined ? resp.code : -1,
        message: errMsg,
        data: null
      };
    }).catch(function(err) {
      return {
        code: -1,
        message: err.message || '\u7f51\u7edc\u5f02\u5e38', // 网络异常
        data: null
      };
    });
  }

  function apiCallGet(path, params) {
    return apiCall('GET', path, params, null);
  }

  function apiCallPost(path, body) {
    return apiCall('POST', path, null, body);
  }

  // ============================================================
  // API 函数
  // ============================================================

  var API = {};

  /**
   * 解析链接：传入 BV号 / AV号 / EP号 / SS号 / URL
   * POST /api/parse
   * 返回 {code, message, data: videoInfo} 格式
   */
  API.parseVideo = function(url) {
    return apiCallPost('/api/parse', { url: url }).then(function(result) {
      if (result.code !== 0 || !result.data) {
        return result;
      }

      var raw = result.data;
      var videoData = null;

      // Worker 返回格式: {parsed: {...}, content: {type: 'video'|'season', data: {...}}}
      if (raw.content && raw.content.data) {
        videoData = raw.content.data;
      } else if (raw.videoInfo) {
        videoData = raw.videoInfo;
      } else if (raw.info) {
        videoData = raw.info;
      } else if (raw.bvid || raw.title) {
        // 已经是视频信息本身
        videoData = raw;
      }

      if (videoData) {
        var normalized = normalizeVideoInfo(videoData);
        // 保留 parsed 信息供前端使用
        normalized._parsed = raw.parsed || null;
        normalized._contentType = raw.content ? raw.content.type : 'video';
        normalized.qualities = [];

        // 拉取播放地址构建清晰度列表（video.qualities 需由 playurl 填充）
        var bvid = normalized.bvid || videoData.bvid || '';
        var pg = (normalized.pages && normalized.pages[0]) || {};
        var cid = pg.cid || videoData.cid || '';
        if (bvid && cid) {
          return apiCallGet('/api/video/playurl', { bvid: bvid, cid: cid }).then(function(p) {
            if (p && p.code === 0 && p.data) {
              var inner = p.data.data || p.data;
              var qs = inner.accept_quality || [];
              var descs = inner.accept_description || [];
              for (var qi = 0; qi < descs.length; qi++) {
                normalized.qualities.push({ code: qs[qi] !== undefined ? qs[qi] : 0, name: descs[qi], qn: qs[qi] });
              }
            }
            return { code: 0, message: 'ok', data: normalized };
          });
        }

        return {
          code: 0,
          message: 'ok',
          data: normalized
        };
      }

      return {
        code: -1,
        message: '无法解析返回数据',
        data: null
      };
    });
  };

  /**
   * 获取视频信息
   * GET /api/video/info?bvid=xxx
   */
  API.getVideoInfo = function(bvid) {
    return apiCallGet('/api/video/info', { bvid: bvid }).then(function(result) {
      if (result.code === 0 && result.data) {
        return {
          code: 0,
          message: 'ok',
          data: normalizeVideoInfo(result.data)
        };
      }
      return result;
    });
  };

  /**
   * 获取播放地址
   * GET /api/video/playurl?bvid=xxx&cid=xxx
   */
  API.getPlayUrl = function(bvid, cid, qn) {
    var params = {
      bvid: bvid,
      cid: cid,
      fnval: 0   // 使用 durl (mp4 直链)，便于原生 <video> 直接播放
    };
    if (qn) params.qn = qn;
    return apiCallGet('/api/video/playurl', params).then(function(result) {
      // 解包: worker jsonOk => {code, data: <B站响应>}, B站响应 => {code, data: playurl内容}
      if (!result) return result;
      var payload = (result.data && result.data.data) ? result.data.data : result.data;
      return normalizePlayInfo(payload);
    });
  };

  /**
   * 获取热门视频列表
   * GET /api/popular
   */
  API.getPopular = function() {
    return apiCallGet('/api/popular').then(function(result) {
      if (result.code !== 0 || !result.data) {
        return result;
      }

      var data = result.data;
      var list = null;

      // data 可能是数组或 {list: [...]} 或 {videos: [...]}
      if (Array.isArray(data)) {
        list = data;
      } else if (data.list && Array.isArray(data.list)) {
        list = data.list;
      } else if (data.videos && Array.isArray(data.videos)) {
        list = data.videos;
      }

      if (list) {
        var normalized = [];
        for (var i = 0; i < list.length; i++) {
          normalized.push(normalizeVideoInfo(list[i]));
        }
        return {
          code: 0,
          message: 'ok',
          data: normalized
        };
      }

      return {
        code: 0,
        message: 'ok',
        data: data
      };
    });
  };

  /**
   * 获取番剧信息
   * GET /api/season/info?epid=xxx&ssid=xxx
   */
  API.getSeasonInfo = function(epid, ssid) {
    return apiCallGet('/api/season/info', {
      epid: epid,
      ssid: ssid
    });
  };

  /**
   * 搜索
   * GET /api/search?keyword=xxx
   */
  API.search = function(keyword) {
    return apiCallGet('/api/search', { keyword: keyword }).then(function(data) {
      if (data && data.code !== -1) {
        return normalizeSearchResult(data);
      }
      return data;
    });
  };

  /**
   * 解析短链接
   * POST /api/resolve
   */
  API.resolveUrl = function(url) {
    return apiCallPost('/api/resolve', { url: url });
  };

  /**
   * 获取下载地址
   * GET /api/download?bvid=xxx&cid=xxx
   */
  API.getDownloadUrl = function(bvid, cid) {
    return apiCallGet('/api/download', {
      bvid: bvid,
      cid: cid
    });
  };

  /**
   * DASH 高清/杜比视界下载（带用户 Cookie，后端 ffmpeg 合并流式返回）
   * 返回原始 Response；由前端决定保存方式
   */
  API.download = function(bvid, cid, qn, filename) {
    var base = getBaseUrl().replace(/\/+$/, '');
    var qs = [];
    if (bvid) qs.push('bvid=' + encodeURIComponent(bvid));
    qs.push('cid=' + encodeURIComponent(cid));
    if (qn) qs.push('qn=' + encodeURIComponent(qn));
    if (filename) qs.push('filename=' + encodeURIComponent(filename));
    var url = base + '/api/video/download' + (qs.length > 0 ? '?' + qs.join('&') : '');

    var headers = {};
    var biliCookies = global.BILIDOWN_BIli_COOKIES || '';
    try {
      biliCookies = biliCookies || (global.localStorage.getItem('bilidown_cookies') || '');
    } catch (e) {}
    if (biliCookies) headers['X-Bili-Cookies'] = biliCookies;

    return fetch(url, { method: 'GET', headers: headers });
  };

  /**
   * 获取收藏夹列表
   * GET /api/fav/list?id=xxx
   */
  API.getFavList = function(id) {
    return apiCallGet('/api/fav/list', { id: id });
  };

  /**
   * 连通性测试
   * GET /api/ping
   */
  API.ping = function() {
    return apiCallGet('/api/ping');
  };

  /**
   * 设置 API 地址
   */
  API.setApiUrl = function(url) {
    global.BILIDOWN_API_URL = url;
    if (url && typeof url === 'string' && url.trim() !== '') {
      try {
        global.localStorage.setItem('bilidown_api_url', url.trim());
      } catch (e) {
        // localStorage 不可用时忽略
      }
    } else {
      try {
        global.localStorage.removeItem('bilidown_api_url');
      } catch (e) {}
    }
  };

  /**
   * 获取当前 API 地址
   */
  API.getApiUrl = function() {
    return global.BILIDOWN_API_URL || '';
  };

  /**
   * 保存 B站登录 Cookie
   * 用于后端绕过 B站对数据中心 IP 的 412 拦截
   * cookies 形如: "SESSDATA=xxx; bili_jct=yyy; buvid3=zzz; buvid4=www"
   */
  API.setBiliCookies = function(cookies) {
    cookies = (cookies || '').trim();
    global.BILIDOWN_BIli_COOKIES = cookies;
    try {
      if (cookies) {
        global.localStorage.setItem('bilidown_cookies', cookies);
      } else {
        global.localStorage.removeItem('bilidown_cookies');
      }
    } catch (e) {}
  };

  /**
   * 获取已保存的 B站登录 Cookie
   */
  API.getBiliCookies = function() {
    if (global.BILIDOWN_BIli_COOKIES) {
      return global.BILIDOWN_BIli_COOKIES;
    }
    try {
      return global.localStorage.getItem('bilidown_cookies') || '';
    } catch (e) {
      return '';
    }
  };

  /**
   * 是否已登录 B站（存在有效 Cookie）
   */
  API.isBiliLoggedIn = function() {
    return /SESSDATA=/.test(API.getBiliCookies());
  };

  /**
   * 生成扫码登录二维码
   * POST /api/auth/qr/create
   * 返回 {code, message, data: {qrcode_key, url, cookies}}
   */
  API.qrCreate = function() {
    return apiCallPost('/api/auth/qr/create', {});
  };

  /**
   * 轮询扫码登录状态
   * POST /api/auth/qr/poll
   * 返回 data.code: 86101未扫码 | 86090已扫码待确认 | 86038已失效 | 0成功
   */
  API.qrPoll = function(qrcodeKey, cookies) {
    return apiCallPost('/api/auth/qr/poll', {
      qrcode_key: qrcodeKey,
      cookies: cookies || ''
    });
  };

  /**
   * 清除已保存的 B站登录 Cookie
   */
  API.clearBiliCookies = function() {
    global.BILIDOWN_BIli_COOKIES = '';
    try {
      global.localStorage.removeItem('bilidown_cookies');
    } catch (e) {}
  };

  // ============================================================
  // 从 localStorage 恢复 API 地址
  // ============================================================

  (function init() {
    // 默认用当前页面同源：本地(localhost)和局域网设备访问时都能自动指向本机后端
    // 仅当页面并非由本后端托管(如 file:// 或纯静态页)时才回退到 localhost:2233
    global.BILIDOWN_DEFAULT_API = (global.location && global.location.origin && /^https?:/.test(global.location.origin))
      ? global.location.origin
      : 'http://localhost:2233';
    try {
      var savedUrl = global.localStorage.getItem('bilidown_api_url');
      global.BILIDOWN_API_URL = (savedUrl && savedUrl.trim()) ? savedUrl.replace(/\/+$/, '') : global.BILIDOWN_DEFAULT_API;
    } catch (e) {
      global.BILIDOWN_API_URL = global.BILIDOWN_DEFAULT_API;
    }
  })();

  // ============================================================
  // 导出
  // ============================================================

  global.API = API;

})(window);