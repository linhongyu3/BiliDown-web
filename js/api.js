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

    info.url = data.url || data.durl || '';
    info.durl = data.durl || data.dash || [];
    info.acceptQuality = data.accept_quality || data.accept_format || [];
    info.acceptDescription = data.accept_description || [];
    info.quality = data.quality || data.current_quality || 0;
    info.format = data.format || '';
    info.dash = data.dash || null;

    // 如果 durl 是数组，把单个 URL 提取出来
    if (info.url === '' && info.durl && info.durl.length > 0) {
      info.url = info.durl[0].url || '';
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
        return resp.data;
      }
      // 业务错误
      var errMsg = resp && resp.message ? resp.message : '\u672a\u77e5\u9519\u8bef'; // 未知错误
      return {
        code: -1,
        message: errMsg,
        data: null
      };
    }).catch(function(err) {
      return {
        code: -1,
        message: err.message || '\u7f51\u7edc\u5f02\u5e38' // 网络异常
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
   */
  API.parseVideo = function(url) {
    return apiCallPost('/api/parse', { url: url }).then(function(data) {
      if (data && data.code !== -1) {
        // 根据返回类型标准化
        if (data.videoInfo) {
          data.videoInfo = normalizeVideoInfo(data.videoInfo);
        }
        if (data.video_info) {
          data.video_info = normalizeVideoInfo(data.video_info);
        }
        if (data.info) {
          data.info = normalizeVideoInfo(data.info);
        }
      }
      return data;
    });
  };

  /**
   * 获取视频信息
   * GET /api/video/info?bvid=xxx
   */
  API.getVideoInfo = function(bvid) {
    return apiCallGet('/api/video/info', { bvid: bvid }).then(function(data) {
      if (data && data.code !== -1) {
        return normalizeVideoInfo(data);
      }
      return data;
    });
  };

  /**
   * 获取播放地址
   * GET /api/video/playurl?bvid=xxx&cid=xxx
   */
  API.getPlayUrl = function(bvid, cid) {
    return apiCallGet('/api/video/playurl', {
      bvid: bvid,
      cid: cid
    }).then(function(data) {
      if (data && data.code !== -1) {
        return normalizePlayInfo(data);
      }
      return data;
    });
  };

  /**
   * 获取热门视频列表
   * GET /api/popular
   */
  API.getPopular = function() {
    return apiCallGet('/api/popular').then(function(data) {
      if (data && data.code !== -1) {
        // data 可能是数组或 {list: [...]}
        if (Array.isArray(data)) {
          var list = [];
          for (var i = 0; i < data.length; i++) {
            list.push(normalizeVideoInfo(data[i]));
          }
          return list;
        }
        if (data.list && Array.isArray(data.list)) {
          var list2 = [];
          for (var j = 0; j < data.list.length; j++) {
            list2.push(normalizeVideoInfo(data.list[j]));
          }
          return list2;
        }
        if (data.videos && Array.isArray(data.videos)) {
          var list3 = [];
          for (var k = 0; k < data.videos.length; k++) {
            list3.push(normalizeVideoInfo(data.videos[k]));
          }
          return list3;
        }
        return data;
      }
      return data;
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

  // ============================================================
  // 从 localStorage 恢复 API 地址
  // ============================================================

  (function init() {
    try {
      var savedUrl = global.localStorage.getItem('bilidown_api_url');
      if (savedUrl) {
        global.BILIDOWN_API_URL = savedUrl;
      }
    } catch (e) {
      // localStorage 不可用时忽略
    }
  })();

  // ============================================================
  // 导出
  // ============================================================

  global.API = API;

})(window);