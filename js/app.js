/**
 * Bilidown Web - 主应用脚本
 * 纯前端 B站视频信息解析工具
 */

(function () {
  'use strict';

  // --- DOM 引用 ---
  const $ = (id) => document.getElementById(id);

  const pageHome = $('page-home');
  const pageResult = $('page-result');
  const pagePlayer = $('page-player');
  const loading = $('loading');
  const toast = $('toast');
  const configModal = $('config-modal');
  const aboutModal = $('about-modal');

  const parseInput = $('parseInput');
  const btnParse = $('btnParse');
  const popularList = $('popularList');
  const historyList = $('historyList');
  const qualityList = $('qualityList');
  const pageList = $('pageList');

  // 结果区
  const resultCover = $('resultCover');
  const resultTitle = $('resultTitle');
  const resultAuthor = $('resultAuthor');
  const authorName = $('authorName');
  const resultDesc = $('resultDesc');
  const resultDuration = $('resultDuration');
  const statPlay = $('statPlay');
  const statDanmaku = $('statDanmaku');
  const statLike = $('statLike');
  const statCoin = $('statCoin');

  // --- 状态 ---
  const STATE = {
    currentVideo: null,       // 当前解析的视频数据
    currentPage: 1,           // 当前分P
    currentQuality: null,     // 当前选中清晰度
    qrKey: null,              // 扫码登录二维码 key
    qrCookies: null,          // 生成二维码时下发的 B站 cookie
    qrTimer: null,            // 扫码状态轮询定时器
  };

  // --- 工具函数 ---

  /**
   * 构建图片代理地址（绕过 B站防盗链）
   * 优先使用 referrerpolicy=no-referrer，失败时回退到代理
   */
  function proxyImage(url) {
    if (!url || url.indexOf('data:') === 0) return url;
    var apiBase = getApiBase();
    if (!apiBase) return url;
    return apiBase + '/api/image?url=' + encodeURIComponent(url);
  }

  /**
   * 图片加载失败处理：先尝试代理，再回退占位图
   * 使用方式: onerror="imgFallback(this)"
   */
  function imgFallback(imgEl) {
    var originalSrc = imgEl.getAttribute('data-original') || imgEl.src;
    var apiBase = getApiBase();

    // 如果还没试过代理，且配置了 API 地址
    if (!imgEl._triedProxy && apiBase && originalSrc.indexOf('api/image') === -1 && originalSrc.indexOf('data:') !== 0) {
      imgEl._triedProxy = true;
      imgEl.setAttribute('data-original', originalSrc);
      imgEl.src = apiBase + '/api/image?url=' + encodeURIComponent(originalSrc);
      return;
    }

    // 已经试过代理还是失败，用占位图
    var svg = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'400\' height=\'225\' fill=\'%23f0f0f0\'/%3E';
    imgEl.src = svg;
  }

  /** 显示页面，隐藏其他 */
  function showPage(page) {
    [pageHome, pageResult, pagePlayer].forEach(p => p.classList.remove('active'));
    page.classList.add('active');

    // 离开播放页时暂停并释放视频，避免离开页面后仍继续播放
    if (page !== pagePlayer) {
      const player = $('videoPlayer');
      if (player) {
        player.pause();
        player.removeAttribute('src');
        player.load();
      }
    }
  }

  /** 显示 Toast 消息 */
  function showToast(msg, duration) {
    duration = duration || 2500;
    toast.textContent = msg;
    toast.classList.remove('hide');
    toast.style.display = 'block';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.add('hide');
      setTimeout(() => { toast.style.display = 'none'; }, 260);
    }, duration);
  }

  /** 显示加载动画 */
  function showLoading(text) {
    text = text || '解析中...';
    loading.querySelector('.loading-text').textContent = text;
    loading.style.display = 'flex';
  }

  /** 隐藏加载动画 */
  function hideLoading() {
    loading.style.display = 'none';
  }

  /** 格式化数字 (万/亿) */
  function formatCount(n) {
    n = Number(n);
    if (isNaN(n)) return '--';
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }

  /** 格式化时长 (秒 -> mm:ss) */
  function formatDuration(sec) {
    if (!sec && sec !== 0) return '--:--';
    sec = Math.floor(Number(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  /** 获取历史记录 */
  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem('bilidown_history') || '[]');
    } catch { return []; }
  }

  /** 保存历史记录 */
  function saveHistory(list) {
    localStorage.setItem('bilidown_history', JSON.stringify(list));
  }

  /** 添加到历史 */
  function addHistory(video) {
    if (!video || !video.bvid) return;
    let list = getHistory();
    list = list.filter(item => item.bvid !== video.bvid);
    list.unshift({
      bvid: video.bvid,
      title: video.title || '未知视频',
      cover: video.cover || '',
      author: video.author || '',
      time: Date.now(),
    });
    if (list.length > 50) list = list.slice(0, 50);
    saveHistory(list);
    renderHistory();
  }

  /** 渲染历史记录 */
  function renderHistory() {
    const list = getHistory();
    if (!list.length) {
      historyList.innerHTML = '<div class="history-empty">暂无历史记录</div>';
      return;
    }
    historyList.innerHTML = list.map(item => `
      <div class="history-item" data-bvid="${item.bvid}">
        <img class="history-item-cover" src="${item.cover || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'68\' fill=\'%23f0f0f0\'/%3E'}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="AppFunctions.imgFallback(this)">
        <div class="history-item-info">
          <div class="history-item-title">${item.title}</div>
          <div class="history-item-meta">${item.author || '未知'}</div>
        </div>
        <button class="history-item-remove" data-action="remove" title="移除">×</button>
      </div>
    `).join('');

    // 事件: 点击条目
    historyList.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="remove"]')) return;
        const bvid = el.dataset.bvid;
        if (bvid) parseVideo(bvid);
      });
    });

    // 事件: 移除按钮
    historyList.querySelectorAll('[data-action="remove"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = btn.closest('.history-item');
        const bvid = item.dataset.bvid;
        let list = getHistory();
        list = list.filter(h => h.bvid !== bvid);
        saveHistory(list);
        renderHistory();
        showToast('已移除');
      });
    });
  }

  // --- 热门视频渲染 ---
  function renderPopularVideos(videos) {
    if (!videos || !videos.length) {
      popularList.innerHTML = '<div class="video-card-placeholder">暂无热门视频</div>';
      return;
    }
    popularList.innerHTML = videos.map((v, i) => `
      <div class="video-card" style="animation-delay:${i * 0.05}s" data-bvid="${v.bvid}">
        <div class="video-card-cover">
          <img src="${v.cover || ''}" alt="${v.title || ''}" loading="lazy" referrerpolicy="no-referrer" onerror="AppFunctions.imgFallback(this)">
          ${v.duration ? `<span class="video-card-duration">${formatDuration(v.duration)}</span>` : ''}
        </div>
        <div class="video-card-body">
          <div class="video-card-title">${v.title || '未知视频'}</div>
          <div class="video-card-meta">
            <span class="video-card-author">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>
              ${v.author || '未知'}
            </span>
            <span>${v.play ? formatCount(v.play) + '播放' : ''}</span>
          </div>
        </div>
      </div>
    `).join('');

    popularList.querySelectorAll('.video-card').forEach(el => {
      el.addEventListener('click', () => {
        const bvid = el.dataset.bvid;
        if (bvid) parseVideo(bvid);
      });
    });
  }

  // --- 加载热门视频 ---
  function loadPopularVideos() {
    popularList.innerHTML = '<div class="video-card-loading">加载中...</div>';

    // 从 localStorage 读取缓存的热门视频
    var cached = localStorage.getItem('bilidown_popular');
    if (cached) {
      try {
        var data = JSON.parse(cached);
        if (Array.isArray(data) && data.length) {
          renderPopularVideos(data);
          // 后台刷新
          refreshPopular();
          return;
        }
      } catch (e) { /* ignore */ }
    }

    // 尝试请求 API
    if (window.API && typeof API.getPopular === 'function') {
      API.getPopular().then(function(res) {
        if (res && res.code === 0 && Array.isArray(res.data) && res.data.length) {
          // data 已经是标准化后的视频数组
          var mapped = res.data.map(function(v) {
            return {
              bvid: v.bvid,
              title: v.title,
              author: v.author,
              cover: v.cover,
              duration: v.duration,
              play: v.view
            };
          });
          renderPopularVideos(mapped);
          try { localStorage.setItem('bilidown_popular', JSON.stringify(mapped)); } catch(e) {}
          return;
        }
        fallbackPopular();
      }).catch(function() {
        fallbackPopular();
      });
    } else {
      fallbackPopular();
    }
  }

  /** 后台刷新热门（静默更新缓存） */
  function refreshPopular() {
    if (!window.API || typeof API.getPopular !== 'function') return;
    API.getPopular().then(function(res) {
      if (res && res.code === 0 && Array.isArray(res.data) && res.data.length) {
        var mapped = res.data.map(function(v) {
          return {
            bvid: v.bvid,
            title: v.title,
            author: v.author,
            cover: v.cover,
            duration: v.duration,
            play: v.view
          };
        });
        renderPopularVideos(mapped);
        try { localStorage.setItem('bilidown_popular', JSON.stringify(mapped)); } catch(e) {}
      }
    }).catch(function() { /* 静默失败，使用缓存 */ });
  }

  /** 使用模拟热门数据 */
  function fallbackPopular() {
    var mockData = [
      { bvid: 'BV1GJ411x7w7', title: '【4K】绝美自然风光纪录片', author: '风光摄影师', cover: 'https://i0.hdslb.com/bfs/archive/9c8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e.jpg', duration: 982, play: 1250000 },
      { bvid: 'BV1GJ411x7w8', title: '【干货】前端性能优化实战指南', author: '前端小课堂', cover: 'https://i0.hdslb.com/bfs/archive/9c8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e.jpg', duration: 2456, play: 890000 },
      { bvid: 'BV1GJ411x7w9', title: '【美食】街头小吃纪录片 第一集', author: '美食探索', cover: 'https://i0.hdslb.com/bfs/archive/9c8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e.jpg', duration: 1520, play: 2300000 },
      { bvid: 'BV1GJ411x7wa', title: '【科技】2026年最值得买的数码产品', author: '科技评测', cover: 'https://i0.hdslb.com/bfs/archive/9c8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e.jpg', duration: 1875, play: 560000 },
      { bvid: 'BV1GJ411x7wb', title: '【教程】从零开始学Python编程', author: '编程入门', cover: 'https://i0.hdslb.com/bfs/archive/9c8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e.jpg', duration: 3600, play: 3100000 },
      { bvid: 'BV1GJ411x7wc', title: '【音乐】经典华语歌曲现场版', author: '音乐频道', cover: 'https://i0.hdslb.com/bfs/archive/9c8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e.jpg', duration: 480, play: 4800000 },
    ];
    renderPopularVideos(mockData);
    try { localStorage.setItem('bilidown_popular', JSON.stringify(mockData)); } catch(e) {}
  }

  // --- 解析视频 (调用 API/Parser 模块) ---

  /** 获取 API 基础地址 (委托 API 模块) */
  function getApiBase() {
    return window.API && typeof API.getApiUrl === 'function'
      ? API.getApiUrl()
      : (localStorage.getItem('bilidown_api_url') || '').replace(/\/+$/, '') || '';
  }

  /** 解析视频 */
  async function parseVideo(input) {
    if (!input) {
      showToast('请输入视频链接或分享文案');
      return;
    }

    showLoading('正在解析...');

    try {
      // 使用 BiliParser 提取链接 (支持 BV/AV/EP/SS/b23.tv/分享文案)
      var parsed = window.BiliParser && BiliParser.getFirstLink(input);
      var linkForApi = input;

      if (parsed && parsed.url) {
        linkForApi = parsed.url;
      } else if (parsed && parsed.value) {
        linkForApi = parsed.value;
      }

      // 调用 API 模块解析
      if (window.API && typeof API.parseVideo === 'function') {
        var result = await API.parseVideo(linkForApi);

        if (result && result.code === 0 && result.data) {
          var video = result.data;

          STATE.currentVideo = video;
          STATE.currentPage = 1;
          STATE.currentQuality = null;

          renderResult(video);
          addHistory(video);
          showPage(pageResult);
          hideLoading();
          showToast('解析成功');
          return;
        }
        throw new Error((result && result.message) || '解析失败');
      } else {
        throw new Error('API 模块未加载');
      }
    } catch (err) {
      hideLoading();
      const msg = (err && err.message) || '未知错误';
      console.error('解析失败:', err);
      showToast('解析失败：' + msg);
    }
  }

  /** 使用模拟数据展示（API 不可用时） */
  function useMockData(input) {
    var parsed = window.BiliParser && BiliParser.getFirstLink(input);
    var id = (parsed && parsed.value) || 'BV1GJ411x7w7';

    const mockVideo = {
      bvid: id,
      title: id === 'BV1GJ411x7w7'
        ? '【4K HDR】冰岛极光全记录｜绝美自然风光'
        : 'Bilibili 视频 - ' + id,
      cover: 'https://i0.hdslb.com/bfs/archive/9c8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e6e8c6c0e.jpg',
      author: '风光摄影师',
      author_face: '',
      desc: '这是一段视频简介。\\n拍摄于冰岛，记录了北极光、冰川、火山等自然奇观。\\n使用 Sony A7S III 拍摄，4K 60fps HDR 格式。\\n\\n如果简介内容较长，可以点击"展开"按钮查看更多内容。',
      duration: 982,
      stat: { view: 1250000, danmaku: 8200, like: 45000, coin: 12000 },
      pages: [
        { page: 1, title: '极光之夜', duration: 240 },
        { page: 2, title: '冰川徒步', duration: 360 },
        { page: 3, title: '火山地貌', duration: 382 },
      ],
      qualities: [
        { name: '4K 超清', code: '120' },
        { name: '1080P 高码', code: '80' },
        { name: '1080P 高清', code: '64' },
        { name: '720P 高清', code: '32' },
        { name: '480P 清晰', code: '16' },
      ],
    };

    STATE.currentVideo = mockVideo;
    STATE.currentPage = 1;
    STATE.currentQuality = null;

    renderResult(mockVideo);
    addHistory(mockVideo);
    showPage(pageResult);
    hideLoading();
    showToast('解析成功 (模拟数据)');
  }

  // --- 渲染结果 ---

  function renderResult(video) {
    // 封面
    resultCover.src = video.cover || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'800\' height=\'450\' fill=\'%23f0f0f0\'/%3E';
    resultCover.alt = video.title || '视频封面';
    resultCover.setAttribute('referrerpolicy', 'no-referrer');
    resultCover.onerror = function() { AppFunctions.imgFallback(this); };

    // 时长
    resultDuration.textContent = video.duration ? formatDuration(video.duration) : '--:--';

    // 标题
    resultTitle.textContent = video.title || '未知视频';

    // UP主
    authorName.textContent = video.author || video.owner?.name || '未知';

    if (video.author_face || video.owner?.face) {
      const face = video.author_face || video.owner?.face;
      const avatarImg = document.createElement('img');
      avatarImg.src = face;
      avatarImg.alt = '';
      avatarImg.onerror = function () { this.style.display = 'none'; };
      const avatarContainer = $('authorAvatar');
      avatarContainer.innerHTML = '';
      avatarContainer.appendChild(avatarImg);
    }

    // 统计
    const s = video.stat || video;
    statPlay.textContent = formatCount(s.view || s.play);
    statDanmaku.textContent = formatCount(s.danmaku);
    statLike.textContent = formatCount(s.like || s.likes);
    statCoin.textContent = formatCount(s.coin || s.coins);

    // 简介
    const desc = video.desc || video.description || '暂无简介';
    resultDesc.textContent = desc;
    resultDesc.classList.remove('expanded');
    const toggleBtn = document.querySelector('.desc-toggle');
    if (desc.length > 80) {
      toggleBtn.style.display = 'inline-flex';
      toggleBtn.textContent = '展开';
    } else {
      toggleBtn.style.display = 'none';
    }

    // 分P
    renderPageList(video.pages || []);

    // 清晰度
    renderQualityList(video.qualities || []);
  }

  /** 渲染分P列表 */
  function renderPageList(pages) {
    if (!pages || !pages.length) {
      pageList.innerHTML = '<div class="page-empty">单集视频</div>';
      return;
    }
    pageList.innerHTML = pages.map((p, idx) => {
      const isActive = (idx + 1) === STATE.currentPage;
      return `
        <div class="page-item ${isActive ? 'active' : ''}" data-page="${p.page || idx + 1}">
          <span class="page-item-index">${p.page || idx + 1}</span>
          <span class="page-item-title">${p.title || 'P' + (p.page || idx + 1)}</span>
          <span class="page-item-duration">${p.duration ? formatDuration(p.duration) : ''}</span>
        </div>
      `;
    }).join('');

    pageList.querySelectorAll('.page-item').forEach(el => {
      el.addEventListener('click', () => {
        const page = parseInt(el.dataset.page);
        if (page === STATE.currentPage) return;
        STATE.currentPage = page;
        el.closest('.page-list').querySelectorAll('.page-item').forEach(p => p.classList.remove('active'));
        el.classList.add('active');
        showToast('已切换到 P' + page);
      });
    });
  }

  /** 渲染清晰度列表 */
  function renderQualityList(qualities) {
    if (!qualities || !qualities.length) {
      qualityList.innerHTML = '<div class="page-empty">无可选清晰度</div>';
      return;
    }
    qualityList.innerHTML = qualities.map(q => {
      const code = q.code || q.quality || q;
      const name = q.name || q.description || code;
      const isActive = STATE.currentQuality === code;
      return `<button class="quality-btn ${isActive ? 'active' : ''}" data-quality="${code}">${name}</button>`;
    }).join('');

    qualityList.querySelectorAll('.quality-btn').forEach(el => {
      el.addEventListener('click', () => {
        const q = el.dataset.quality;
        STATE.currentQuality = q;
        qualityList.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
        el.classList.add('active');
        showToast('已选择清晰度');
      });
    });
  }

  // --- 播放 ---
  function playVideo() {
    const video = STATE.currentVideo;
    if (!video) {
      showToast('请先解析视频');
      return;
    }

    const mode = localStorage.getItem('bilidown_player_mode') || 'direct';

    if (mode === 'redirect') {
      const url = video.bvid
        ? `https://www.bilibili.com/video/${video.bvid}`
        : `https://www.bilibili.com/video/${video.bvid || ''}`;
      window.open(url, '_blank');
      showToast('已跳转B站播放');
      return;
    }

    // 直接播放模式
    const player = $('videoPlayer');
    const playerTitle = $('playerTitle');

    const page = (video.pages && video.pages[STATE.currentPage - 1]) || {};
    const cid = page.cid;
    const bvid = video.bvid || '';

    // 无论当前是否已有清晰度，都根据所选清晰度重新拉取真实播放地址
    showLoading('获取播放地址...');
    const qn = STATE.currentQuality || '64';

    Promise.all([
      window.API && API.getPlayUrl ? API.getPlayUrl(bvid, cid, qn) : Promise.resolve(null)
    ]).then(function(results) {
      hideLoading();
      const playInfo = results[0];
      if (!playInfo || !playInfo.url) {
        showToast('无法获取播放地址');
        return;
      }
      playerTitle.textContent = video.title || '正在播放';
      // crossOrigin=anonymous 让媒体请求走 CORS（后端返回 ACAO:*），避免跨源/ORB opaque 拦截
      player.crossOrigin = 'anonymous';
      // 走后端流代理（同源），并附上已解析好的直链，避免代理二次换质
      const apiBase = getApiBase();
      player.src = `${apiBase}/api/video/stream?url=${encodeURIComponent(playInfo.url)}&qn=${encodeURIComponent(qn)}`;
      showPage(pagePlayer);
      player.load();
      player.play().catch(() => {
        // 自动播放可能被阻止
      });
    }).catch(function() {
      hideLoading();
      showToast('获取播放地址失败');
    });
  }

  // --- 复制链接 ---
  function copyLink() {
    const video = STATE.currentVideo;
    if (!video) {
      showToast('请先解析视频');
      return;
    }
    const bvid = video.bvid || '';
    const url = bvid ? `https://www.bilibili.com/video/${bvid}` : window.location.href;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('链接已复制');
      }).catch(() => {
        fallbackCopy(url);
      });
    } else {
      fallbackCopy(url);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('链接已复制');
  }

  // --- 下载 ---
  function sanitize(name) {
    return (name || 'video').replace(/[\\/:*?"<>|]/g, '_').trim();
  }

  function buildFilename(video, partName, label) {
    const cleanTitle = sanitize(video.title || 'video');
    const cleanPart = (partName && partName !== cleanTitle ? '-' + sanitize(partName) : '');
    return `${cleanTitle}${cleanPart}-${label || 'video'}.mp4`;
  }

  // 从已渲染的清晰度列表里取当前清晰度标签
  function currentQualityLabel(qn) {
    const qs = (STATE.currentVideo && STATE.currentVideo.qualities) || [];
    for (let i = 0; i < qs.length; i++) {
      const c = qs[i].code || qs[i].quality || qs[i].qn;
      if (String(c) === String(qn)) return qs[i].name || qs[i].description || qn;
    }
    return qn + 'P';
  }

  // 流式写入磁盘（File System Access API，Chromium），大文件不占内存
  function saveStreamToDisk(stream, filename) {
    return new Promise(function (resolve, reject) {
      if (!window.showSaveFilePicker) {
        reject(new Error('unsupported'));
        return;
      }
      window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }],
      }).then(function (handle) {
        return handle.createWritable().then(async function (writable) {
          const reader = stream.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await writable.write(value);
            }
            await writable.close();
            resolve();
          } catch (e) {
            try { await writable.abort(); } catch (_) {}
            reject(e);
          }
        });
      }).catch(reject);
    });
  }

  function triggerBlobDownload(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function downloadVideo() {
    const video = STATE.currentVideo;
    if (!video) {
      showToast('请先解析视频');
      return;
    }

    const page = (video.pages && video.pages[STATE.currentPage - 1]) || {};
    const cid = page.cid;
    const bvid = video.bvid || '';
    const partName = page.part || '';
    const qn = STATE.currentQuality || '64';

    if (!cid) {
      showToast('无法获取该分P的视频 ID');
      return;
    }

    const label = currentQualityLabel(qn);
    const filename = buildFilename(video, partName, label);
    const qnNum = Number(qn);

    // 低清晰度（<1080P）走 durl/mp4 直链代理，轻量。高清/4K/杜比走 DASH 合并
    if (qnNum < 80) {
      showLoading('获取下载地址...');
      Promise.resolve(window.API && API.getPlayUrl ? API.getPlayUrl(bvid, cid, qn) : Promise.resolve(null))
        .then(function (playInfo) {
          if (!playInfo || !playInfo.url) {
            hideLoading();
            showToast('无法获取下载地址');
            return;
          }
          const apiBase = getApiBase();
          const streamUrl = `${apiBase}/api/video/stream?url=${encodeURIComponent(playInfo.url)}&qn=${encodeURIComponent(qn)}`;
          showLoading('正在下载（大文件请耐心等待）...');
          // 同源<a download>直链：浏览器边下边存，显示真实进度
          const a = document.createElement('a');
          a.href = streamUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          hideLoading();
          showToast('开始下载: ' + filename, 3500);
        })
        .catch(function (err) {
          hideLoading();
          showToast('下载失败: ' + (err.message || err));
        });
      return;
    }

    // 高清/DASH：带 Cookie 请求后端，ffmpeg 合并视频+音频轨流式返回
    showLoading('正在获取 ' + label + ' 流（需要 ffmpeg）...');
    if (!window.API || typeof API.download !== 'function') {
      hideLoading();
      showToast('DASH 下载暂不可用');
      return;
    }

    API.download(bvid, cid, qn, filename)
      .then(function (resp) {
        if (!resp.ok) {
          return resp.json().catch(function () { return null; }).then(function (j) {
            throw new Error((j && j.message) || '下载失败: HTTP ' + resp.status);
          });
        }
        hideLoading();
        return saveStreamToDisk(resp.body, filename).then(function () {
          showToast('已保存: ' + filename, 3500);
        }).catch(function (e) {
          // 不支持流式保存则回退 Blob 下载
          return resp.blob().then(function (blob) {
            triggerBlobDownload(blob, filename);
            showToast('开始下载: ' + filename, 3500);
          });
        });
      })
      .catch(function (err) {
        hideLoading();
        showToast('下载失败: ' + (err.message || err));
      });
  }

  // --- 弹窗控制 ---
  function openConfig() {
    // 统一从 API 模块读取当前地址（内部使用 bilidown_api_url 键）
    const saved = (window.API && typeof API.getApiUrl === 'function') ? API.getApiUrl() : '';
    $('apiUrlInput').value = saved || '';
    const mode = localStorage.getItem('bilidown_player_mode') || 'direct';
    $('playerMode').value = mode;
    // 回填已保存的 B站 Cookie
    const cookies = (window.API && typeof API.getBiliCookies === 'function') ? API.getBiliCookies() : '';
    $('biliCookiesInput').value = cookies || '';
    configModal.style.display = 'flex';
    updateQrLoginUI();
  }

  function closeConfig() {
    configModal.style.display = 'none';
    stopQrLogin();
  }

  function saveConfig() {
    const apiUrl = $('apiUrlInput').value.trim();
    const mode = $('playerMode').value;
    // 统一通过 API 模块保存（使用 bilidown_api_url 键，与 API 读取一致）
    if (apiUrl) {
      if (window.API && typeof API.setApiUrl === 'function') {
        API.setApiUrl(apiUrl);
      } else {
        localStorage.setItem('bilidown_api_url', apiUrl);
        window.BILIDOWN_API_URL = apiUrl;
      }
    }
    // 保存 B站登录 Cookie（可选，用于绕过 412）
    const biliCookies = $('biliCookiesInput').value.trim();
    if (window.API && typeof API.setBiliCookies === 'function') {
      API.setBiliCookies(biliCookies);
    } else {
      try {
        if (biliCookies) {
          localStorage.setItem('bilidown_cookies', biliCookies);
        } else {
          localStorage.removeItem('bilidown_cookies');
        }
        window.BILIDOWN_BIli_COOKIES = biliCookies;
      } catch (e) {}
    }
    localStorage.setItem('bilidown_player_mode', mode);
    closeConfig();
    showToast('设置已保存');
  }

  function openAbout() {
    aboutModal.style.display = 'flex';
  }

  function closeAbout() {
    aboutModal.style.display = 'none';
  }

  // ============================================================
  // B站扫码登录
  // ============================================================

  /** 更新登录状态显示 */
  function updateQrLoginUI() {
    const loggedIn = window.API && typeof API.isBiliLoggedIn === 'function' && API.isBiliLoggedIn();
    if ($('qrLoggedIn')) {
      $('qrLoggedIn').style.display = loggedIn ? 'block' : 'none';
    }
  }

  /** 显示扫码状态文字 */
  function showQrStatus(text, showRefresh) {
    if (!$('qrStatus')) return;
    $('qrStatus').textContent = text || '';
    if ($('btnQrRefresh')) {
      $('btnQrRefresh').style.display = showRefresh ? 'inline-block' : 'none';
    }
  }

  /** 用 qrcode 库渲染二维码到容器 */
  function renderQr(url) {
    const box = $('qrBox');
    if (!box) return;
    box.innerHTML = '';
    if (typeof window.qrcode !== 'function') {
      showQrStatus('二维码组件加载失败，请刷新页面重试', true);
      return;
    }
    try {
      const qr = window.qrcode(0, 'L');
      qr.addData(url);
      qr.make();
      box.innerHTML = qr.createImgTag(4, 8);
    } catch (e) {
      showQrStatus('二维码生成失败: ' + (e.message || e), true);
    }
  }

  /** 停止扫码轮询 */
  function stopQrLogin() {
    if (STATE.qrTimer) {
      clearInterval(STATE.qrTimer);
      STATE.qrTimer = null;
    }
    STATE.qrKey = null;
  }

  /** 开始扫码登录：生成二维码并轮询状态 */
  async function startQrLogin() {
    stopQrLogin();
    if (!getApiBase()) {
      showToast('请先填写 API 地址');
      return;
    }
    if (!$('qrPanel')) return;
    $('qrPanel').style.display = 'flex';
    showQrStatus('正在生成二维码...', false);

    const res = await API.qrCreate();
    if (res.code !== 0 || !res.data || !res.data.qrcode_key) {
      showQrStatus('生成失败：' + (res.message || '未知错误'), true);
      return;
    }
    if (!res.data.url) {
      showQrStatus('未返回登录链接，请刷新重试', true);
      return;
    }

    STATE.qrKey = res.data.qrcode_key;
    STATE.qrCookies = res.data.cookies || '';
    renderQr(res.data.url);
    showQrStatus('请使用「B站」App 扫码，然后在手机上确认登录', false);

    // 每 2 秒轮询一次
    STATE.qrTimer = setInterval(pollQrStatus, 2000);
    pollQrStatus();
  }

  /** 轮询扫码状态 */
  async function pollQrStatus() {
    if (!STATE.qrKey) return;
    const res = await API.qrPoll(STATE.qrKey, STATE.qrCookies);
    if (res.code !== 0 || !res.data) {
      return; // 网络/服务错误，等待下次轮询
    }
    const st = res.data.code;
    if (st === 0) {
      // 登录成功
      const cookies = res.data.cookies || '';
      if (!cookies) {
        stopQrLogin();
        showQrStatus('登录成功但未取到 Cookie，请刷新二维码重试', true);
        return;
      }
      API.setBiliCookies(cookies);
      if ($('biliCookiesInput')) $('biliCookiesInput').value = cookies;
      stopQrLogin();
      if ($('qrPanel')) $('qrPanel').style.display = 'none';
      updateQrLoginUI();
      showToast('扫码登录成功');
    } else if (st === 86090) {
      showQrStatus('已扫码，请在手机上「确认登录」', false);
    } else if (st === 86038) {
      stopQrLogin();
      showQrStatus('二维码已失效，请点击刷新', true);
    } else if (st === 86101) {
      showQrStatus('请使用「B站」App 扫码，然后在手机上确认登录', false);
    }
    // 其他状态码继续轮询
  }

  /** 清除 B站登录 */
  function clearBiliLogin() {
    stopQrLogin();
    if (window.API && typeof API.clearBiliCookies === 'function') {
      API.clearBiliCookies();
    }
    if ($('biliCookiesInput')) $('biliCookiesInput').value = '';
    if ($('qrPanel')) $('qrPanel').style.display = 'none';
    updateQrLoginUI();
    showToast('已清除 B站登录');
  }

  // --- 清除历史 ---
  function clearHistory() {
    saveHistory([]);
    renderHistory();
    showToast('历史已清除');
  }

  // --- 简介展开/收起 ---
  function toggleDesc() {
    const isExpanded = resultDesc.classList.toggle('expanded');
    document.querySelector('.desc-toggle').textContent = isExpanded ? '收起' : '展开';
  }

  // --- 键盘快捷键 ---
  function handleKeydown(e) {
    if (e.key === 'Enter' && document.activeElement === parseInput) {
      e.preventDefault();
      btnParse.click();
    }
    if (e.key === 'Escape') {
      if (configModal.style.display === 'flex') closeConfig();
      if (aboutModal.style.display === 'flex') closeAbout();
    }
  }

  // --- 初始化 ---
  function init() {
    // 事件绑定
    btnParse.addEventListener('click', () => parseVideo(parseInput.value.trim()));
    $('btnPlay').addEventListener('click', playVideo);
    $('btnCopy').addEventListener('click', copyLink);
    $('btnDownload').addEventListener('click', downloadVideo);
    $('btnConfig').addEventListener('click', openConfig);
    $('btnAbout').addEventListener('click', openAbout);
    $('btnCloseModal').addEventListener('click', closeConfig);
    $('btnCancelModal').addEventListener('click', closeConfig);
    $('btnSaveConfig').addEventListener('click', saveConfig);
    $('btnCloseAbout').addEventListener('click', closeAbout);
    $('btnClearHistory').addEventListener('click', clearHistory);
    $('btnRefreshPopular').addEventListener('click', loadPopularVideos);
    $('btnToggleDesc').addEventListener('click', toggleDesc);
    $('btnBackResult').addEventListener('click', () => showPage(pageResult));
    $('btnQrLogin') && $('btnQrLogin').addEventListener('click', startQrLogin);
    $('btnQrRefresh') && $('btnQrRefresh').addEventListener('click', startQrLogin);
    $('btnClearCookies') && $('btnClearCookies').addEventListener('click', clearBiliLogin);

    // 弹窗背景点击关闭
    configModal.addEventListener('click', (e) => { if (e.target === configModal) closeConfig(); });
    aboutModal.addEventListener('click', (e) => { if (e.target === aboutModal) closeAbout(); });

    // 键盘
    document.addEventListener('keydown', handleKeydown);

    // 加载热门视频
    loadPopularVideos();

    // 加载历史记录
    renderHistory();

    // 默认显示首页
    showPage(pageHome);

    console.log('Bilidown Web 已启动');
    console.log('API 地址:', getApiBase());
  }

  // 等待 DOM 就绪
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 导出到全局（供 HTML 模板字符串中的 onerror 内联事件调用）
  // 注意：仅暴露真实存在且实际被使用的函数，避免引用未定义函数
  window.AppFunctions = {
    imgFallback: imgFallback,
    proxyImage: proxyImage,
    parseVideo: parseVideo,
    playVideo: playVideo,
    downloadVideo: downloadVideo,
    copyLink: copyLink,
    toggleDesc: toggleDesc,
    clearHistory: clearHistory,
    openConfig: openConfig,
    closeConfig: closeConfig,
    openAbout: openAbout,
    closeAbout: closeAbout,
  };

})();