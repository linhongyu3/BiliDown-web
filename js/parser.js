/**
 * Bilidown - B站链接解析器
 * 纯函数，无外部依赖，ES5 兼容
 */

;(function(global) {
  'use strict';

  var Parser = {};

  // ============================================================
  // 正则规则
  // ============================================================

  /**
   * 从文本中提取 B站 各类链接/ID
   * 支持: bv, av, ep, ss, fav, b23.tv 短链接
   */

  // BV号: BV1开头，后接字母数字，总长度12
  var RE_BV = /BV1[a-zA-Z0-9]{9,11}/gi;

  // AV号
  var RE_AV = /[Aa][Vv](\d+)/g;

  // EP号
  var RE_EP = /[Ee][Pp](\d+)/g;

  // SS号
  var RE_SS = /[Ss][Ss](\d+)/g;

  // 收藏夹/合集
  var RE_FAV = /[Ff][Aa][Vv](\d+)/g;
  var RE_ML = /[Mm][Ll](\d+)/g;

  // b23.tv 短链接 (含 https?:// 前缀)
  var RE_B23 = /https?:\/\/b23\.tv\/([\w-]+)/gi;

  // 通用 URL 检测 (用于 extractUrl)
  var RE_URL = /https?:\/\/[^\s"'<>]+/gi;

  // ============================================================
  // parseBiliLink(text) -> {type, value, raw} | null
  // ============================================================

  /**
   * 解析文本中的 B站 链接，返回第一个匹配结果
   * @param {string} text - 输入文本
   * @returns {object|null} - {type, value, raw} 或 null
   */
  function parseBiliLink(text) {
    if (!text || typeof text !== 'string') {
      return null;
    }

    var trimmed = text.trim();
    if (trimmed === '') {
      return null;
    }

    // 优先级: b23 短链接 > BV > AV > EP > SS > FAV

    // 1. b23.tv 短链接
    RE_B23.lastIndex = 0;
    var m = RE_B23.exec(trimmed);
    if (m) {
      return {
        type: 'short',
        value: m[1],
        raw: m[0]
      };
    }

    // 2. BV号 (完整URL或纯BV号)
    RE_BV.lastIndex = 0;
    m = RE_BV.exec(trimmed);
    if (m) {
      return {
        type: 'bv',
        value: m[0].toUpperCase(),
        raw: m[0]
      };
    }

    // 3. AV号
    RE_AV.lastIndex = 0;
    m = RE_AV.exec(trimmed);
    if (m) {
      return {
        type: 'av',
        value: m[1],
        raw: m[0]
      };
    }

    // 4. EP号
    RE_EP.lastIndex = 0;
    m = RE_EP.exec(trimmed);
    if (m) {
      return {
        type: 'ep',
        value: m[1],
        raw: m[0]
      };
    }

    // 5. SS号
    RE_SS.lastIndex = 0;
    m = RE_SS.exec(trimmed);
    if (m) {
      return {
        type: 'ss',
        value: m[1],
        raw: m[0]
      };
    }

    // 6. 收藏夹 FAV
    RE_FAV.lastIndex = 0;
    m = RE_FAV.exec(trimmed);
    if (m) {
      return {
        type: 'fav',
        value: m[1],
        raw: m[0]
      };
    }

    // 7. 合集 ML
    RE_ML.lastIndex = 0;
    m = RE_ML.exec(trimmed);
    if (m) {
      return {
        type: 'ml',
        value: m[1],
        raw: m[0]
      };
    }

    return null;
  }

  // ============================================================
  // extractUrl(text) -> string | null
  // ============================================================

  /**
   * 从文本中提取第一个 URL
   * @param {string} text - 输入文本
   * @returns {string|null} - URL 或 null
   */
  function extractUrl(text) {
    if (!text || typeof text !== 'string') {
      return null;
    }

    RE_URL.lastIndex = 0;
    var m = RE_URL.exec(text);
    if (m) {
      return m[0];
    }

    return null;
  }

  // ============================================================
  // getFirstLink(text) -> {type, value, url} | null
  // ============================================================

  /**
   * 返回文本中第一个 B站 链接的详细信息
   * @param {string} text - 输入文本
   * @returns {object|null} - {type, value, url} 或 null
   */
  function getFirstLink(text) {
    if (!text || typeof text !== 'string') {
      return null;
    }

    var parsed = parseBiliLink(text);
    if (!parsed) {
      return null;
    }

    var url = buildBiliUrl(parsed.type, parsed.value);
    return {
      type: parsed.type,
      value: parsed.value,
      url: url
    };
  }

  // ============================================================
  // 内部辅助: 根据 type/value 构建 B站 URL
  // ============================================================

  function buildBiliUrl(type, value) {
    switch (type) {
      case 'bv':
        return 'https://www.bilibili.com/video/' + value;
      case 'av':
        return 'https://www.bilibili.com/video/av' + value;
      case 'ep':
        return 'https://www.bilibili.com/bangumi/play/ep' + value;
      case 'ss':
        return 'https://www.bilibili.com/bangumi/play/ss' + value;
      case 'fav':
        return 'https://www.bilibili.com/favlist/fold' + value;
      case 'ml':
        return 'https://www.bilibili.com/medialist/play/ml' + value;
      case 'short':
        return 'https://b23.tv/' + value;
      default:
        return '';
    }
  }

  // ============================================================
  // formatDuration(seconds) -> "MM:SS" 或 "HH:MM:SS"
  // ============================================================

  /**
   * 将秒数格式化为 MM:SS 或 HH:MM:SS
   * @param {number} seconds - 秒数
   * @returns {string} - 格式化后的时间字符串
   */
  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) {
      return '00:00';
    }

    var s = Math.floor(seconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;

    var pad = function(n) {
      return n < 10 ? '0' + n : '' + n;
    };

    if (h > 0) {
      return pad(h) + ':' + pad(m) + ':' + pad(sec);
    }
    return pad(m) + ':' + pad(sec);
  }

  // ============================================================
  // formatCount(num) -> "1.2万" | "1亿" | "1234"
  // ============================================================

  /**
   * 将数字格式化为中文计数：万/亿
   * @param {number} num - 数字
   * @returns {string} - 格式化后的字符串
   */
  function formatCount(num) {
    if (typeof num !== 'number' || isNaN(num)) {
      return '0';
    }

    if (num >= 100000000) {
      var yi = num / 100000000;
      return yi.toFixed(1).replace(/\.0$/, '') + '\u4ebf'; // 亿
    }

    if (num >= 10000) {
      var wan = num / 10000;
      return wan.toFixed(1).replace(/\.0$/, '') + '\u4e07'; // 万
    }

    return '' + num;
  }

  // ============================================================
  // formatTime(timestamp) -> "2024-01-01"
  // ============================================================

  /**
   * 将时间戳格式化为 YYYY-MM-DD
   * @param {number|string} timestamp - 时间戳（秒或毫秒）或日期字符串
   * @returns {string} - "YYYY-MM-DD" 格式
   */
  function formatTime(timestamp) {
    if (!timestamp && timestamp !== 0) {
      return '未知';
    }

    var date;

    if (typeof timestamp === 'string') {
      // 尝试直接解析字符串
      date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        // 如果是数字字符串
        var num = parseInt(timestamp, 10);
        if (!isNaN(num)) {
          date = new Date(num * (num > 10000000000 ? 1 : 1000));
        }
      }
    } else if (typeof timestamp === 'number') {
      // B站 API 通常返回秒级时间戳
      date = new Date(timestamp * (timestamp > 10000000000 ? 1 : 1000));
    } else {
      return '未知';
    }

    if (!date || isNaN(date.getTime())) {
      return '未知';
    }

    var y = date.getFullYear();
    var m = padNum(date.getMonth() + 1);
    var d = padNum(date.getDate());

    return y + '-' + m + '-' + d;
  }

  function padNum(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  // ============================================================
  // 导出
  // ============================================================

  Parser.parseBiliLink = parseBiliLink;
  Parser.extractUrl = extractUrl;
  Parser.getFirstLink = getFirstLink;
  Parser.formatDuration = formatDuration;
  Parser.formatCount = formatCount;
  Parser.formatTime = formatTime;
  Parser.buildBiliUrl = buildBiliUrl;

  // 挂载到全局
  global.BiliParser = Parser;

})(window);