/**
 * TransForge — 1:1 屏幕实时原位翻译双端工作台前端核心逻辑 (PC 后端 + iOS .ipa 独立双栖版)
 * 支持：
 * 1. PC / 局域网联机模式：连接本地 FastAPI 服务
 * 2. iOS 独立 .ipa 原生模式：脱离电脑后端，直接调用 iOS Apple Vision 原生硬件级 OCR + 百度翻译 API 直连
 */

const presetEnv = window.__PRESET_ENV__ ?? {};
const savedLocalCfg = (() => {
  try {
    return JSON.parse(localStorage.getItem("transforge_cfg") ?? "{}");
  } catch {
    return {};
  }
})();

const initialBaiduId = savedLocalCfg?.baidu?.app_id || presetEnv.BAIDU_APP_ID || "";
const initialBaiduKey = savedLocalCfg?.baidu?.app_key || presetEnv.BAIDU_SECRET_KEY || "";

const state = {
  activeEngine: initialBaiduId && initialBaiduKey ? "baidu" : "google",
  sourceLang: "auto",
  targetLang: "zh",
  displayMode: "inplace",
  isPhoneFrame: true,
  isLiveSync: true,
  isPiPActive: false,
  backendAvailable: false,
  currentSessionId: "",
  originalImage: "",
  renderedImage: "",
  blocks: [],
  toggledOriginalIds: new Set(),
  highlightedId: "",
  config: {
    baidu: {
      app_id: initialBaiduId,
      app_key: initialBaiduKey
    },
    tencent: {
      secret_id: savedLocalCfg?.tencent?.secret_id ?? "",
      secret_key: savedLocalCfg?.tencent?.secret_key ?? ""
    }
  },
  enginesStatus: {
    google: { configured: true, label: "Ready" },
    baidu: {
      configured: Boolean(initialBaiduId && initialBaiduKey),
      label: initialBaiduId && initialBaiduKey ? "Connected" : "Not Configured"
    },
    tencent: {
      configured: Boolean(savedLocalCfg?.tencent?.secret_id && savedLocalCfg?.tencent?.secret_key),
      label: savedLocalCfg?.tencent?.secret_id && savedLocalCfg?.tencent?.secret_key ? "Connected" : "Not Configured"
    }
  }
};

/**
 * 纯 JS UTF-8 MD5 哈希实现（供 iOS 独立 .ipa 直接签名调用百度翻译 API，零外部依赖）
 * @param {string} str 输入文本
 * @returns {string} 32位小写十六进制 MD5
 */
const md5Utf8 = (str) => {
  const utf8Bytes = new TextEncoder().encode(str);
  const rotateLeft = (lValue, iShiftBits) => (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  const addUnsigned = (lX, lY) => {
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
      return lResult ^ 0x40000000 ^ lX8 ^ lY8;
    }
    return lResult ^ lX8 ^ lY8;
  };
  const f = (x, y, z) => (x & y) | (~x & z);
  const g = (x, y, z) => (x & z) | (y & ~z);
  const h = (x, y, z) => x ^ y ^ z;
  const i = (x, y, z) => y ^ (x | ~z);
  const ff = (a, b, c, d, x, s, ac) => addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(f(b, c, d), x), ac)), s), b);
  const gg = (a, b, c, d, x, s, ac) => addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(g(b, c, d), x), ac)), s), b);
  const hh = (a, b, c, d, x, s, ac) => addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(h(b, c, d), x), ac)), s), b);
  const ii = (a, b, c, d, x, s, ac) => addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(i(b, c, d), x), ac)), s), b);

  const lByteLength = utf8Bytes.length;
  const lNumberOfWordsTemp1 = lByteLength + 8;
  const lNumberOfWordsTemp2 = (lNumberOfWordsTemp1 - (lNumberOfWordsTemp1 % 64)) / 64;
  const lNumberOfWords = (lNumberOfWordsTemp2 + 1) * 16;
  const lWordArray = new Array(lNumberOfWords).fill(0);
  let lBytePosition = 0;
  let lByteCount = 0;
  while (lByteCount < lByteLength) {
    const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordCount] = lWordArray[lWordCount] | (utf8Bytes[lByteCount] << lBytePosition);
    lByteCount++;
  }
  const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
  lBytePosition = (lByteCount % 4) * 8;
  lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
  lWordArray[lNumberOfWords - 2] = lByteLength << 3;
  lWordArray[lNumberOfWords - 1] = lByteLength >>> 29;

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let k = 0; k < lWordArray.length; k += 16) {
    const AA = a;
    const BB = b;
    const CC = c;
    const DD = d;
    a = ff(a, b, c, d, lWordArray[k + 0], 7, 0xd76aa478);
    d = ff(d, a, b, c, lWordArray[k + 1], 12, 0xe8c7b756);
    c = ff(c, d, a, b, lWordArray[k + 2], 17, 0x242070db);
    b = ff(b, c, d, a, lWordArray[k + 3], 22, 0xc1bdceee);
    a = ff(a, b, c, d, lWordArray[k + 4], 7, 0xf57c0faf);
    d = ff(d, a, b, c, lWordArray[k + 5], 12, 0x4787c62a);
    c = ff(c, d, a, b, lWordArray[k + 6], 17, 0xa8304613);
    b = ff(b, c, d, a, lWordArray[k + 7], 22, 0xfd469501);
    a = ff(a, b, c, d, lWordArray[k + 8], 7, 0x698098d8);
    d = ff(d, a, b, c, lWordArray[k + 9], 12, 0x8b44f7af);
    c = ff(c, d, a, b, lWordArray[k + 10], 17, 0xffff5bb1);
    b = ff(b, c, d, a, lWordArray[k + 11], 22, 0x895cd7be);
    a = ff(a, b, c, d, lWordArray[k + 12], 7, 0x6b901122);
    d = ff(d, a, b, c, lWordArray[k + 13], 12, 0xfd987193);
    c = ff(c, d, a, b, lWordArray[k + 14], 17, 0xa679438e);
    b = ff(b, c, d, a, lWordArray[k + 15], 22, 0x49b40821);
    a = gg(a, b, c, d, lWordArray[k + 1], 5, 0xf61e2562);
    d = gg(d, a, b, c, lWordArray[k + 6], 9, 0xc040b340);
    c = gg(c, d, a, b, lWordArray[k + 11], 14, 0x265e5a51);
    b = gg(b, c, d, a, lWordArray[k + 0], 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, lWordArray[k + 5], 5, 0xd62f105d);
    d = gg(d, a, b, c, lWordArray[k + 10], 9, 0x02441453);
    c = gg(c, d, a, b, lWordArray[k + 15], 14, 0xd8a1e681);
    b = gg(b, c, d, a, lWordArray[k + 4], 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, lWordArray[k + 9], 5, 0x21e1cde6);
    d = gg(d, a, b, c, lWordArray[k + 14], 9, 0xc33707d6);
    c = gg(c, d, a, b, lWordArray[k + 3], 14, 0xf4d50d87);
    b = gg(b, c, d, a, lWordArray[k + 8], 20, 0x455a14ed);
    a = gg(a, b, c, d, lWordArray[k + 13], 5, 0xa9e3e905);
    d = gg(d, a, b, c, lWordArray[k + 2], 9, 0xfcefa3f8);
    c = gg(c, d, a, b, lWordArray[k + 7], 14, 0x676f02d9);
    b = gg(b, c, d, a, lWordArray[k + 12], 20, 0x8d2a4c8a);
    a = hh(a, b, c, d, lWordArray[k + 5], 4, 0xfffa3942);
    d = hh(d, a, b, c, lWordArray[k + 8], 11, 0x8771f681);
    c = hh(c, d, a, b, lWordArray[k + 11], 16, 0x6d9d6122);
    b = hh(b, c, d, a, lWordArray[k + 14], 23, 0xfde5380c);
    a = hh(a, b, c, d, lWordArray[k + 1], 4, 0xa4beea44);
    d = hh(d, a, b, c, lWordArray[k + 4], 11, 0x4bdecfa9);
    c = hh(c, d, a, b, lWordArray[k + 7], 16, 0xf6bb4b60);
    b = hh(b, c, d, a, lWordArray[k + 10], 23, 0xbebfbc70);
    a = hh(a, b, c, d, lWordArray[k + 13], 4, 0x289b7ec6);
    d = hh(d, a, b, c, lWordArray[k + 0], 11, 0xeaa127fa);
    c = hh(c, d, a, b, lWordArray[k + 3], 16, 0xd4ef3085);
    b = hh(b, c, d, a, lWordArray[k + 6], 23, 0x04881d05);
    a = hh(a, b, c, d, lWordArray[k + 9], 4, 0xd9d4d039);
    d = hh(d, a, b, c, lWordArray[k + 12], 11, 0xe6db99e5);
    c = hh(c, d, a, b, lWordArray[k + 15], 16, 0x1fa27cf8);
    b = hh(b, c, d, a, lWordArray[k + 2], 23, 0xc4ac5665);
    a = ii(a, b, c, d, lWordArray[k + 0], 6, 0xf4292244);
    d = ii(d, a, b, c, lWordArray[k + 7], 10, 0x432aff97);
    c = ii(c, d, a, b, lWordArray[k + 14], 15, 0xab9423a7);
    b = ii(b, c, d, a, lWordArray[k + 5], 21, 0xfc93a039);
    a = ii(a, b, c, d, lWordArray[k + 12], 6, 0x655b59c3);
    d = ii(d, a, b, c, lWordArray[k + 3], 10, 0x8f0ccc92);
    c = ii(c, d, a, b, lWordArray[k + 10], 15, 0xffeff47d);
    b = ii(b, c, d, a, lWordArray[k + 1], 21, 0x85845dd1);
    a = ii(a, b, c, d, lWordArray[k + 8], 6, 0x6fa87e4f);
    d = ii(d, a, b, c, lWordArray[k + 15], 10, 0xfe2ce6e0);
    c = ii(c, d, a, b, lWordArray[k + 6], 15, 0xa3014314);
    b = ii(b, c, d, a, lWordArray[k + 13], 21, 0x4e0811a1);
    a = ii(a, b, c, d, lWordArray[k + 4], 6, 0xf7537e82);
    d = ii(d, a, b, c, lWordArray[k + 11], 10, 0xbd3af235);
    c = ii(c, d, a, b, lWordArray[k + 2], 15, 0x2ad7d2bb);
    b = ii(b, c, d, a, lWordArray[k + 9], 21, 0xeb86d391);
    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }
  const toHex = (val) => {
    let out = "";
    for (let cnt = 0; cnt <= 3; cnt++) {
      const byte = (val >>> (cnt * 8)) & 255;
      out += byte.toString(16).padStart(2, "0");
    }
    return out;
  };
  return (toHex(a) + toHex(b) + toHex(c) + toHex(d)).toLowerCase();
};

/**
 * 调用 iOS 原生 Apple Vision OCR (若运行在 Capacitor iOS App 内)
 * @param {string} base64Str 图片 Base64
 * @returns {Promise<Array>} 识别出的文本行数组
 */
const invokeIosNativeVisionOcr = (base64Str) => {
  return new Promise((resolve) => {
    const handler = window.webkit?.messageHandlers?.nativeOcr;
    if (!handler) {
      resolve(null);
      return;
    }
    const cbId = `ocr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    window.__ocrCallbacks = window.__ocrCallbacks ?? {};
    window.__onNativeOcrResult = (id, lines) => {
      const fn = window.__ocrCallbacks?.[id];
      if (fn) {
        delete window.__ocrCallbacks[id];
        fn(lines);
      }
    };
    const timer = setTimeout(() => {
      delete window.__ocrCallbacks[cbId];
      resolve([]);
    }, 6000);

    window.__ocrCallbacks[cbId] = (lines) => {
      clearTimeout(timer);
      resolve(Array.isArray(lines) ? lines : []);
    };
    handler.postMessage({ callbackId: cbId, imageBase64: base64Str });
  });
};

/**
 * 端侧直接调用百度翻译 API (通过官方 JSONP 零跨域限制直连)
 * @param {string[]} texts 原文数组
 * @returns {Promise<string[]>} 译文数组
 */
const clientBaiduTranslateBatch = (texts) => {
  return new Promise((resolve, reject) => {
    const appid = state.config?.baidu?.app_id ?? "";
    const key = state.config?.baidu?.app_key ?? "";
    if (!appid || !key) {
      reject(new Error("未配置百度翻译密钥"));
      return;
    }
    const langMap = { auto: "auto", zh: "zh", en: "en", ja: "jp", ko: "kor", fr: "fra", es: "spa", de: "de", ru: "ru" };
    const from = langMap[state.sourceLang] ?? "auto";
    const to = langMap[state.targetLang] ?? "zh";
    const q = texts.map((t) => t.replace(/\r?\n/g, " ")).join("\n");
    const salt = String(Date.now());
    const sign = md5Utf8(`${appid}${q}${salt}${key}`);
    const cbName = `__baiduTransCb_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const script = document.createElement("script");
    const cleanup = () => {
      delete window[cbName];
      script.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("百度翻译请求超时"));
    }, 8000);

    window[cbName] = (res) => {
      clearTimeout(timer);
      cleanup();
      if (res?.error_code) {
        reject(new Error(`百度翻译错误 (${res.error_code}): ${res.error_msg}`));
        return;
      }
      const dstList = (res?.trans_result ?? []).map((item) => item.dst ?? "");
      resolve(texts.map((orig, idx) => dstList[idx] ?? orig));
    };

    const params = new URLSearchParams({ q, from, to, appid, salt, sign, callback: cbName });
    script.src = `https://fanyi-api.baidu.com/api/trans/vip/translate?${params.toString()}`;
    script.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("百度翻译网络加载失败"));
    };
    document.body.appendChild(script);
  });
};

/**
 * 端侧调用 Google 极速免配置翻译兜底
 * @param {string[]} texts 原文数组
 * @returns {Promise<string[]>} 译文数组
 */
const clientGoogleTranslateBatch = async (texts) => {
  const joined = texts.map((t) => t.replace(/\r?\n/g, " ")).join("\n");
  const tl = state.targetLang === "zh" ? "zh-CN" : state.targetLang;
  const params = new URLSearchParams({ client: "gtx", sl: state.sourceLang, tl, dt: "t", q: joined });
  const resp = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`);
  const data = await resp.json();
  const full = (data?.[0] ?? []).map((part) => part?.[0] ?? "").join("");
  const lines = full.split("\n").map((s) => s.trim());
  return texts.map((orig, i) => lines[i] ?? orig);
};

/**
 * 获取 DOM 元素引用
 */
const dom = {
  sourceLangSelect: document.getElementById("sourceLangSelect"),
  targetLangSelect: document.getElementById("targetLangSelect"),
  engineChips: Array.from(document.querySelectorAll(".engine-chip")),
  modeBtns: Array.from(document.querySelectorAll(".mode-btn[data-mode]")),
  providerCards: Array.from(document.querySelectorAll(".provider-card")),
  btnHoldCompare: document.getElementById("btnHoldCompare"),
  btnUploadImg: document.getElementById("btnUploadImg"),
  fileInput: document.getElementById("fileInput"),
  btnCapturePc: document.getElementById("btnCapturePc"),
  btnLoadDemo: document.getElementById("btnLoadDemo"),
  btnToggleFrame: document.getElementById("btnToggleFrame"),
  frameModeLabel: document.getElementById("frameModeLabel"),
  btnExportImage: document.getElementById("btnExportImage"),
  btnCopyAll: document.getElementById("btnCopyAll"),
  btnLiveSync: document.getElementById("btnLiveSync"),

  deviceViewport: document.getElementById("deviceViewport"),
  screenImage: document.getElementById("screenImage"),
  overlayLayer: document.getElementById("overlayLayer"),
  loadingOverlay: document.getElementById("loadingOverlay"),
  loadingText: document.getElementById("loadingText"),
  metaBadge: document.getElementById("metaBadge"),
  itemCountBadge: document.getElementById("itemCountBadge"),
  textBlocksList: document.getElementById("textBlocksList"),

  topDotBaidu: document.getElementById("topDotBaidu"),
  topDotTencent: document.getElementById("topDotTencent"),
  cardDotBaidu: document.getElementById("cardDotBaidu"),
  cardLabelBaidu: document.getElementById("cardLabelBaidu"),
  cardDotTencent: document.getElementById("cardDotTencent"),
  cardLabelTencent: document.getElementById("cardLabelTencent"),

  apiModal: document.getElementById("apiModal"),
  btnOpenApiModal: document.getElementById("btnOpenApiModal"),
  btnManageApi: document.getElementById("btnManageApi"),
  btnCloseApiModal: document.getElementById("btnCloseApiModal"),
  btnCancelApiModal: document.getElementById("btnCancelApiModal"),
  btnSaveApiConfig: document.getElementById("btnSaveApiConfig"),
  cfgActiveEngine: document.getElementById("cfgActiveEngine"),
  cfgBaiduAppId: document.getElementById("cfgBaiduAppId"),
  cfgBaiduAppKey: document.getElementById("cfgBaiduAppKey"),
  cfgTencentId: document.getElementById("cfgTencentId"),
  cfgTencentKey: document.getElementById("cfgTencentKey"),

  shortcutModal: document.getElementById("shortcutModal"),
  btnOpenShortcutModal: document.getElementById("btnOpenShortcutModal"),
  btnCloseShortcutModal: document.getElementById("btnCloseShortcutModal"),
  btnDoneShortcutModal: document.getElementById("btnDoneShortcutModal"),
  shortcutUrlCode: document.getElementById("shortcutUrlCode"),
  mobileWebUrlCode: document.getElementById("mobileWebUrlCode"),
  btnCopyShortcutUrl: document.getElementById("btnCopyShortcutUrl"),

  mobBtnPiP: document.getElementById("mobBtnPiP"),
  mobPipSub: document.getElementById("mobPipSub"),
  mobPipMain: document.getElementById("mobPipMain"),
  btnTogglePiP: document.getElementById("btnTogglePiP"),
  pipBtnLabel: document.getElementById("pipBtnLabel"),
  pipLiveBanner: document.getElementById("pipLiveBanner"),
  pipBannerText: document.getElementById("pipBannerText"),
  btnTranslateLatestShot: document.getElementById("btnTranslateLatestShot"),
  btnStopPiPBanner: document.getElementById("btnStopPiPBanner"),
  mobBtnUpload: document.getElementById("mobBtnUpload"),
  mobBtnEngine: document.getElementById("mobBtnEngine"),
  mobEngineLabel: document.getElementById("mobEngineLabel"),
  mobBtnHoldCompare: document.getElementById("mobBtnHoldCompare"),
  mobModeLabel: document.getElementById("mobModeLabel"),
  mobBtnShortcut: document.getElementById("mobBtnShortcut"),

  toastContainer: document.getElementById("toastContainer")
};

const showToast = (message) => {
  const item = document.createElement("div");
  item.className = "toast-msg";
  item.textContent = message;
  dom.toastContainer?.appendChild(item);
  setTimeout(() => {
    item.style.opacity = "0";
    item.style.transform = "translateY(8px)";
    setTimeout(() => item.remove(), 220);
  }, 2400);
};

const setLoading = (visible, text = "正在执行端侧 OCR 与整屏并行翻译...") => {
  if (!dom.loadingOverlay) return;
  if (dom.loadingText) dom.loadingText.textContent = text;
  dom.loadingOverlay.classList.toggle("hidden", !visible);
};

const escapeHtml = (raw) => {
  const str = String(raw ?? "");
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
};

const renderEngineStatusUI = () => {
  const { activeEngine, enginesStatus } = state;

  dom.engineChips.forEach((chip) => {
    const eng = chip.dataset.engine ?? "";
    chip.classList.toggle("active", eng === activeEngine);
  });

  dom.providerCards.forEach((card) => {
    const provider = card.dataset.provider ?? "";
    card.classList.toggle("active-provider", provider === activeEngine);
  });

  const baiduOk = Boolean(enginesStatus?.baidu?.configured);
  const tencentOk = Boolean(enginesStatus?.tencent?.configured);

  dom.topDotBaidu?.classList.toggle("online", baiduOk);
  dom.cardDotBaidu?.classList.toggle("online", baiduOk);
  if (dom.cardLabelBaidu) {
    dom.cardLabelBaidu.textContent = enginesStatus?.baidu?.label ?? "Not Configured";
  }

  dom.topDotTencent?.classList.toggle("online", tencentOk);
  dom.cardDotTencent?.classList.toggle("online", tencentOk);
  if (dom.cardLabelTencent) {
    dom.cardLabelTencent.textContent = enginesStatus?.tencent?.label ?? "Not Configured";
  }

  const engineDisplayNames = {
    google: "Google",
    baidu: "百度翻译",
    tencent: "腾讯 TMT"
  };
  if (dom.mobEngineLabel) {
    dom.mobEngineLabel.textContent = engineDisplayNames[activeEngine] ?? "百度翻译";
  }
};

const renderOverlayLayer = () => {
  if (!dom.overlayLayer) return;

  const { displayMode, blocks, toggledOriginalIds, highlightedId } = state;
  dom.overlayLayer.className = `overlay-layer mode-${displayMode}`;

  const stageW = dom.screenImage?.clientWidth || dom.overlayLayer?.clientWidth || 340;
  const stageH = dom.screenImage?.clientHeight || dom.overlayLayer?.clientHeight || 580;
  const isCompactStage = stageW < 420;
  const minFontPx = isCompactStage ? 9 : 11;
  const maxFontPx = isCompactStage ? 15 : 22;

  const htmlFragments = blocks.map((blk) => {
    const isShowingOrig = toggledOriginalIds.has(blk.id);
    const displayText = isShowingOrig ? (blk.original ?? "") : (blk.translated ?? "-");
    const isHighlighted = highlightedId === blk.id ? "highlighted" : "";

    const lineCount = Math.max(1, Number(blk.line_count ?? 1));
    const boxPxW = Math.max(24, (Number(blk.nw ?? 10) / 100) * stageW);
    const boxPxH = Math.max(14, (Number(blk.nh ?? 3) / 100) * stageH);
    const charCount = Math.max(1, displayText.length);
    const fontByHeight = (boxPxH / lineCount) * 0.68;
    const fontByArea = Math.sqrt((boxPxW * boxPxH * 0.76) / charCount);
    const approxFontPx = Math.max(minFontPx, Math.min(maxFontPx, Math.round(Math.min(fontByHeight, fontByArea))));

    if (displayMode === "inplace") {
      return `
        <div
          class="ocr-overlay-item ${isHighlighted}"
          data-id="${escapeHtml(blk.id)}"
          title="点击切换原文/译文 · 双击复制译文"
          style="
            left: ${blk.nx}%;
            top: ${blk.ny}%;
            width: ${blk.nw}%;
            min-height: ${blk.nh}%;
            background-color: ${escapeHtml(blk.bg_color ?? "#121214")};
            color: ${escapeHtml(blk.fg_color ?? "#f8fafc")};
            font-size: ${approxFontPx}px;
          "
        >
          <span class="inplace-text">${escapeHtml(displayText)}</span>
        </div>
      `;
    }

    return `
      <div
        class="ocr-overlay-item ${isHighlighted}"
        data-id="${escapeHtml(blk.id)}"
        title="${escapeHtml(blk.translated ?? "")}"
        style="
          left: ${blk.nx}%;
          top: ${blk.ny}%;
          width: ${blk.nw}%;
          height: ${blk.nh}%;
        "
      >
        <span class="bbox-tag">${escapeHtml(blk.id)}</span>
      </div>
    `;
  });

  dom.overlayLayer.innerHTML = htmlFragments.join("");
};

const renderBlocksList = () => {
  if (!dom.textBlocksList) return;
  const { blocks, highlightedId } = state;

  if (dom.itemCountBadge) {
    dom.itemCountBadge.textContent = `${blocks.length} 项`;
  }

  if (blocks.length === 0) {
    dom.textBlocksList.innerHTML = `
      <div class="block-card">
        <div class="row-val-orig">当前画面未检测到外文文本，可尝试上传新截图或点击上方「演示样张」。</div>
      </div>
    `;
    return;
  }

  const cardsHtml = blocks.map((blk) => {
    const isHighlighted = highlightedId === blk.id ? "highlighted" : "";
    return `
      <article class="block-card ${isHighlighted}" data-id="${escapeHtml(blk.id)}">
        <div class="block-card-head">
          <div class="block-title-wrap">
            <span class="t-badge">${escapeHtml(blk.id)}</span>
            <span class="block-headline">${escapeHtml(blk.original ?? "-")}</span>
          </div>
          <button type="button" class="copy-icon-btn" data-copy-id="${escapeHtml(blk.id)}" title="复制该段译文" aria-label="复制译文">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>
        <div class="block-row">
          <span class="row-label">Original</span>
          <span class="row-val-orig">${escapeHtml(blk.original ?? "-")}</span>
        </div>
        <div class="block-row">
          <span class="row-label">Chinese</span>
          <span class="row-val-trans">${escapeHtml(blk.translated ?? "-")}</span>
        </div>
      </article>
    `;
  });

  dom.textBlocksList.innerHTML = cardsHtml.join("");
};

const applyTranslationSession = (session) => {
  if (!session) return;

  state.currentSessionId = session.session_id ?? "";
  state.originalImage = session.original_image ?? "";
  state.renderedImage = session.rendered_image ?? session.original_image ?? "";
  state.blocks = Array.isArray(session.blocks) ? session.blocks : [];
  state.toggledOriginalIds.clear();

  if (dom.screenImage && state.originalImage) {
    dom.screenImage.src = state.originalImage;
  }

  if (dom.metaBadge) {
    const w = session.width ?? 0;
    const h = session.height ?? 0;
    const ms = session.total_ms ?? 0;
    const eng = (session.engine ?? state.activeEngine).toUpperCase();
    dom.metaBadge.textContent = `${w} × ${h} · ${eng} · ${ms} ms`;
  }

  renderOverlayLayer();
  renderBlocksList();

  if (state.isPiPActive && state.renderedImage) {
    pushFrameToPiP(state.renderedImage);
  }
};

// Web 端画中画 Video 后备支持
let webPipCanvas = null;
let webPipVideo = null;
let webLiveTimer = null;

const updatePiPUI = (active) => {
  state.isPiPActive = active;
  dom.btnTogglePiP?.classList.toggle("pip-running", active);
  dom.mobBtnPiP?.classList.toggle("pip-running", active);
  dom.pipLiveBanner?.classList.toggle("hidden", !active);

  if (dom.pipBtnLabel) {
    dom.pipBtnLabel.textContent = active ? "实时翻译中（点击关闭）" : "开启实时翻译";
  }
  if (dom.mobPipSub) {
    dom.mobPipSub.textContent = active ? "实时翻译中" : "录屏 + 悬浮窗";
  }
  if (dom.mobPipMain) {
    dom.mobPipMain.textContent = active ? "点击关闭" : "开启实时翻译";
  }
};

const pushFrameToPiP = (renderedBase64) => {
  if (!renderedBase64) return;
  if (webPipCanvas) {
    const img = new Image();
    img.onload = () => {
      const ctx = webPipCanvas.getContext("2d");
      ctx.fillStyle = "#09090b";
      ctx.fillRect(0, 0, webPipCanvas.width, webPipCanvas.height);
      const scale = Math.min(webPipCanvas.width / img.naturalWidth, webPipCanvas.height / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, (webPipCanvas.width - dw) / 2, (webPipCanvas.height - dh) / 2, dw, dh);
    };
    img.src = renderedBase64;
  }
};

/**
 * 原生持续自动翻译引擎状态回调
 * @param {{active:boolean,pip:boolean,connected:boolean,frames:number,engine:string,hint:string,items:Array<{src:string,dst:string}>}} payload
 */
let lastLiveHint = "";
window.__onLiveState = (payload) => {
  const p = payload ?? {};
  updatePiPUI(Boolean(p.active));

  if (dom.pipBannerText) {
    if (!p.active) {
      dom.pipBannerText.textContent = "实时翻译已关闭";
    } else if (!p.connected) {
      dom.pipBannerText.textContent = "等待录屏开始：在系统弹窗中点「开始直播」，或在控制中心长按「屏幕录制」选择 TransForge";
    } else {
      const pipText = p.pip ? "悬浮窗已开启" : "悬浮窗未开启（切到后台会自动弹出）";
      dom.pipBannerText.textContent = `录屏已连接 · ${pipText} · 已接收 ${p.frames ?? 0} 帧 · 引擎：${p.engine ?? "-"}`;
    }
  }

  if (p.hint && p.hint !== lastLiveHint) {
    lastLiveHint = p.hint;
    showToast(p.hint);
  }

  const items = Array.isArray(p.items) ? p.items : [];
  if (p.active && items.length > 0) {
    renderLiveItems(items);
  }
};

/**
 * 在右侧列表中渲染实时翻译结果
 * @param {Array<{src:string,dst:string}>} items 翻译条目
 */
const renderLiveItems = (items) => {
  if (!dom.textBlocksList) return;
  if (dom.itemCountBadge) dom.itemCountBadge.textContent = `${items.length} 项`;
  dom.textBlocksList.innerHTML = items
    .map(
      (it, i) => `
      <article class="block-card">
        <div class="block-card-head">
          <div class="block-title-wrap">
            <span class="t-badge">T${i + 1}</span>
            <span class="block-headline">${escapeHtml(it.dst ?? "")}</span>
          </div>
        </div>
        <div class="block-row">
          <span class="row-label">原文</span>
          <span class="row-val-orig">${escapeHtml(it.src ?? "")}</span>
        </div>
      </article>`
    )
    .join("");
};

const toggleLivePiPMode = async () => {
  const nativeHandler = window.webkit?.messageHandlers?.nativeOcr;
  if (nativeHandler) {
    nativeHandler.postMessage({
      action: state.isPiPActive ? "stopLive" : "startLive",
      baiduAppId: state.config?.baidu?.app_id ?? "",
      baiduSecretKey: state.config?.baidu?.app_key ?? "",
      targetLang: state.targetLang ?? "zh"
    });
    return;
  }

  // Web / 电脑浏览器端画中画 + 自动轮询支持
  if (state.isPiPActive) {
    updatePiPUI(false);
    if (webLiveTimer) {
      clearInterval(webLiveTimer);
      webLiveTimer = null;
    }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture().catch(() => {});
    }
    showToast("已关闭悬浮实时翻译模式");
    return;
  }

  try {
    if (!webPipCanvas) {
      webPipCanvas = document.createElement("canvas");
      webPipCanvas.width = 720;
      webPipCanvas.height = 1280;
    }
    if (state.renderedImage) {
      pushFrameToPiP(state.renderedImage);
    }
    if (!webPipVideo) {
      webPipVideo = document.createElement("video");
      webPipVideo.muted = true;
      webPipVideo.playsInline = true;
      webPipVideo.style.position = "fixed";
      webPipVideo.style.width = "1px";
      webPipVideo.style.height = "1px";
      webPipVideo.style.opacity = "0.01";
      webPipVideo.style.pointerEvents = "none";
      document.body.appendChild(webPipVideo);
      webPipVideo.srcObject = webPipCanvas.captureStream(10);
    }
    await webPipVideo.play().catch(() => {});
    if (webPipVideo.requestPictureInPicture) {
      await webPipVideo.requestPictureInPicture();
    } else if (webPipVideo.webkitSetPresentationMode) {
      webPipVideo.webkitSetPresentationMode("picture-in-picture");
    }
    updatePiPUI(true);
    showToast("已开启全局画中画实时悬浮窗！切回任意软件即可悬浮查看译文");

    if (state.backendAvailable) {
      webLiveTimer = setInterval(() => {
        if (state.isPiPActive) triggerPcCapture();
      }, 4500);
    }
  } catch (err) {
    updatePiPUI(true);
    showToast("已开启实时自动监听模式（若在 iPhone 请使用打包的 IPA 启动原生画中画）");
  }
};

const triggerLatestScreenshotTranslate = () => {
  const nativeHandler = window.webkit?.messageHandlers?.nativeOcr;
  if (nativeHandler) {
    nativeHandler.postMessage({ action: "openPicker" });
    return;
  }
  dom.fileInput?.click();
};

const highlightBlock = (blockId, scrollCard = false) => {
  state.highlightedId = blockId;

  const overlayItems = Array.from(dom.overlayLayer?.querySelectorAll(".ocr-overlay-item") ?? []);
  overlayItems.forEach((el) => {
    el.classList.toggle("highlighted", el.dataset.id === blockId);
  });

  const listCards = Array.from(dom.textBlocksList?.querySelectorAll(".block-card") ?? []);
  listCards.forEach((card) => {
    const matched = card.dataset.id === blockId;
    card.classList.toggle("highlighted", matched);
    if (matched && scrollCard) {
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
};

/**
 * 端侧 Canvas 采样局部背景色、合并段落并生成 1:1 汉化合成图（供 iOS 独立 .ipa 运行）
 */
const runStandalonePipeline = async (base64Data, presetLines = null) => {
  const t0 = performance.now();
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = base64Data;
  });

  const imgW = img.naturalWidth || 750;
  const imgH = img.naturalHeight || 1334;
  const canvas = document.createElement("canvas");
  canvas.width = imgW;
  canvas.height = imgH;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  let rawLines = presetLines;
  if (!rawLines) {
    rawLines = await invokeIosNativeVisionOcr(base64Data);
  }
  if (!rawLines || rawLines.length === 0) {
    throw new Error("未检测到文本（若在电脑端请启动 start.bat，iPhone 端请使用打包的 IPA）");
  }

  // 按阅读顺序排序并合并同段落相邻文本行
  const sorted = [...rawLines].sort((a, b) => a.y - b.y || a.x - b.x);
  const merged = [];
  sorted.forEach((line) => {
    const curr = { ...line, line_count: 1 };
    if (merged.length === 0) {
      merged.push(curr);
      return;
    }
    const prev = merged[merged.length - 1];
    const prevBottom = prev.y + prev.h;
    const avgH = (prev.h / prev.line_count + curr.h) / 2;
    const vGap = curr.y - prevBottom;
    const leftDiff = Math.abs(curr.x - prev.x);
    const ratio = Math.max(curr.h, avgH) / Math.max(1, Math.min(curr.h, avgH));

    if (vGap >= -avgH * 0.35 && vGap <= avgH * 1.15 && leftDiff <= Math.max(48, imgW * 0.08) && ratio <= 1.42) {
      const nx = Math.min(prev.x, curr.x);
      const ny = Math.min(prev.y, curr.y);
      const nr = Math.max(prev.x + prev.w, curr.x + curr.w);
      const nb = Math.max(prevBottom, curr.y + curr.h);
      prev.text = `${prev.text} ${curr.text}`;
      prev.x = nx;
      prev.y = ny;
      prev.w = nr - nx;
      prev.h = nb - ny;
      prev.line_count += 1;
    } else {
      merged.push(curr);
    }
  });

  // 采样每个框边缘的背景色并计算对比度前景色
  const blocks = merged.map((blk, idx) => {
    const sx = Math.max(0, Math.floor(blk.x));
    const sy = Math.max(0, Math.floor(blk.y));
    const pixel = ctx.getImageData(sx, sy, 1, 1).data;
    const [r, g, b] = [pixel[0], pixel[1], pixel[2]];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const bgHex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    const fgHex = lum < 0.54 ? "#f8fafc" : "#09090b";

    return {
      id: `T${idx + 1}`,
      index: idx + 1,
      original: blk.text.trim(),
      translated: "",
      x: Math.round(blk.x),
      y: Math.round(blk.y),
      w: Math.round(blk.w),
      h: Math.round(blk.h),
      nx: Number(((blk.x / imgW) * 100).toFixed(3)),
      ny: Number(((blk.y / imgH) * 100).toFixed(3)),
      nw: Number(((blk.w / imgW) * 100).toFixed(3)),
      nh: Number(((blk.h / imgH) * 100).toFixed(3)),
      bg_color: bgHex,
      fg_color: fgHex,
      line_count: blk.line_count
    };
  });

  // 调用百度翻译 API (JSONP) 或 Google 翻译
  const originals = blocks.map((b) => b.original);
  let translatedList = originals;
  let usedEngine = state.activeEngine;

  try {
    if (state.activeEngine === "baidu" && state.config?.baidu?.app_id && state.config?.baidu?.app_key) {
      translatedList = await clientBaiduTranslateBatch(originals);
      usedEngine = "baidu";
    } else {
      translatedList = await clientGoogleTranslateBatch(originals);
      usedEngine = "google";
    }
  } catch {
    translatedList = await clientGoogleTranslateBatch(originals).catch(() => originals);
    usedEngine = "google";
  }

  blocks.forEach((b, i) => {
    b.translated = translatedList[i] ?? b.original;
    // 在 Canvas 上绘制 1:1 原位覆盖供导出
    ctx.fillStyle = b.bg_color;
    ctx.fillRect(b.x - 4, b.y - 2, b.w + 8, b.h + 4);
    ctx.fillStyle = b.fg_color;
    const fontSize = Math.max(14, Math.min(40, Math.floor((b.h / b.line_count) * 0.72)));
    ctx.font = `bold ${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(b.translated, b.x, b.y + 2, b.w + 4);
  });

  const totalMs = Math.round(performance.now() - t0);
  return {
    session_id: `local_${Date.now()}`,
    width: imgW,
    height: imgH,
    engine: usedEngine,
    total_ms: totalMs,
    blocks,
    original_image: base64Data,
    rendered_image: canvas.toDataURL("image/png")
  };
};

/**
 * 端侧生成演示画面与精确坐标框（供 iOS 独立 .ipa 开箱即用演示）
 */
const createStandaloneDemoScreen = () => {
  const w = 750;
  const h = 1334;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0f1117";
  ctx.fillRect(0, 0, w, h);

  const grad = ctx.createLinearGradient(40, 60, 40, 560);
  grad.addColorStop(0, "#122a44");
  grad.addColorStop(1, "#385a64");
  ctx.fillStyle = grad;
  ctx.fillRect(40, 60, w - 80, 500);

  ctx.fillStyle = "#101c2c";
  ctx.fillRect(76, 110, 264, 46);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 22px -apple-system, sans-serif";
  ctx.fillText("Amalfi Coast, Italy", 92, 140);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 48px -apple-system, sans-serif";
  ctx.fillText("Discover", 76, 225);
  ctx.fillText("Your Next", 76, 285);
  ctx.fillText("Adventure", 76, 345);

  ctx.fillStyle = "#e2e8f0";
  ctx.font = "24px -apple-system, sans-serif";
  ctx.fillText("Explore the world, one trip", 76, 415);
  ctx.fillText("at a time with expert guides.", 76, 451);

  ctx.fillStyle = "#181a22";
  ctx.fillRect(40, 595, w - 80, 73);
  ctx.fillStyle = "#d2dae6";
  ctx.fillText("Search destinations and hotels", 80, 640);

  ctx.fillStyle = "#181b24";
  ctx.fillRect(40, 700, 318, 95);
  ctx.fillRect(392, 700, 318, 95);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 30px -apple-system, sans-serif";
  ctx.fillText("Luxury Hotels", 74, 758);
  ctx.fillText("Direct Flights", 426, 758);

  ctx.fillText("Popular Destinations", 48, 862);

  ctx.fillStyle = "#f1f5f9";
  ctx.fillRect(40, 895, w - 80, 225);
  ctx.fillStyle = "#0f172a";
  ctx.font = "23px -apple-system, sans-serif";
  ctx.fillText("The coastal train leaves every", 74, 960);
  ctx.fillText("morning at eight. Book your", 74, 1004);
  ctx.fillText("window seat early for the trip.", 74, 1048);

  ctx.fillStyle = "#10b981";
  ctx.fillRect(40, 1175, w - 80, 90);
  ctx.fillStyle = "#09090b";
  ctx.font = "bold 30px -apple-system, sans-serif";
  ctx.fillText("Reserve Instant Pass", 215, 1230);

  const presetLines = [
    { text: "Amalfi Coast, Italy", x: 92, y: 118, w: 220, h: 30 },
    { text: "Discover Your Next Adventure", x: 76, y: 185, w: 260, h: 175 },
    { text: "Explore the world, one trip at a time with expert guides.", x: 76, y: 390, w: 325, h: 72 },
    { text: "Search destinations and hotels", x: 80, y: 616, w: 350, h: 32 },
    { text: "Luxury Hotels", x: 74, y: 732, w: 210, h: 36 },
    { text: "Direct Flights", x: 426, y: 732, w: 205, h: 36 },
    { text: "Popular Destinations", x: 48, y: 835, w: 310, h: 36 },
    { text: "The coastal train leaves every morning at eight. Book your window seat early for the trip.", x: 74, y: 936, w: 355, h: 126 },
    { text: "Reserve Instant Pass", x: 215, y: 1200, w: 310, h: 38 }
  ];

  return { base64: canvas.toDataURL("image/png"), presetLines };
};

const translateBase64Image = async (base64Data, sourceDevice = "mobile") => {
  setLoading(true, "正在提取屏幕坐标并调用百度/高速翻译引擎...");
  try {
    if (state.backendAvailable) {
      const resp = await fetch("/api/translate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: base64Data,
          engine: state.activeEngine,
          source_lang: state.sourceLang,
          target_lang: state.targetLang,
          source_device: sourceDevice
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        applyTranslationSession(data);
        showToast(`已完成 ${data.blocks?.length ?? 0} 处文本 1:1 原位翻译 (${data.total_ms ?? 0}ms)`);
        return;
      }
    }

    // 独立 iOS .ipa 端侧模式 (Apple Vision OCR + 百度翻译直连)
    const session = await runStandalonePipeline(base64Data);
    applyTranslationSession(session);
    showToast(`已完成 ${session.blocks.length} 处文本 1:1 原位翻译 (${session.total_ms}ms)`);
  } catch (err) {
    showToast(`翻译失败: ${err.message}`);
  } finally {
    setLoading(false);
  }
};

const triggerBuiltinDemo = async () => {
  setLoading(true, "正在生成演示屏幕并调用百度翻译 API...");
  try {
    if (state.backendAvailable) {
      const resp = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine: state.activeEngine,
          source_lang: state.sourceLang,
          target_lang: state.targetLang
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        applyTranslationSession(data);
        return;
      }
    }

    const { base64, presetLines } = createStandaloneDemoScreen();
    const session = await runStandalonePipeline(base64, presetLines);
    applyTranslationSession(session);
  } catch (err) {
    showToast(`加载演示画面失败: ${err.message}`);
  } finally {
    setLoading(false);
  }
};

const triggerPcCapture = async () => {
  setLoading(true, "正在截取当前电脑屏幕并执行原位翻译...");
  try {
    const resp = await fetch("/api/capture-pc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: state.activeEngine,
        source_lang: state.sourceLang,
        target_lang: state.targetLang
      })
    });
    if (!resp.ok) throw new Error(`截屏失败 (${resp.status})`);
    const data = await resp.json();
    state.isPhoneFrame = false;
    dom.deviceViewport?.classList.remove("phone-frame");
    dom.deviceViewport?.classList.add("wide-frame");
    if (dom.frameModeLabel) dom.frameModeLabel.textContent = "宽幅桌面视图";
    applyTranslationSession(data);
    showToast(`电脑屏幕截取翻译完成 (${data.total_ms ?? 0}ms)`);
  } catch (err) {
    showToast(`电脑截屏需在电脑端启动 start.bat`);
  } finally {
    setLoading(false);
  }
};

const handleImageFile = (file) => {
  if (!file || !file.type.startsWith("image/")) {
    showToast("请选择有效的图片文件");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const resultStr = String(reader.result ?? "");
    if (resultStr) {
      translateBase64Image(resultStr, "upload");
    }
  };
  reader.readAsDataURL(file);
};

const bindEvents = () => {
  dom.sourceLangSelect?.addEventListener("change", (e) => {
    state.sourceLang = e.target.value;
    if (state.originalImage) translateBase64Image(state.originalImage);
  });

  dom.targetLangSelect?.addEventListener("change", (e) => {
    state.targetLang = e.target.value;
    window.webkit?.messageHandlers?.nativeOcr?.postMessage({ action: "config", targetLang: state.targetLang });
    if (state.originalImage) translateBase64Image(state.originalImage);
  });

  dom.engineChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const targetEng = chip.dataset.engine ?? "baidu";
      state.activeEngine = targetEng;
      renderEngineStatusUI();
      if (state.originalImage) {
        translateBase64Image(state.originalImage);
      }
    });
  });

  dom.providerCards.forEach((card) => {
    card.addEventListener("click", () => {
      const provider = card.dataset.provider ?? "baidu";
      if (provider !== "google" && !state.enginesStatus?.[provider]?.configured) {
        dom.apiModal?.classList.remove("hidden");
        return;
      }
      state.activeEngine = provider;
      renderEngineStatusUI();
      if (state.originalImage) {
        translateBase64Image(state.originalImage);
      }
    });
  });

  dom.modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode ?? "inplace";
      state.displayMode = mode;
      dom.modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
      renderOverlayLayer();
    });
  });

  const startCompare = () => {
    dom.overlayLayer?.classList.add("compare-hidden");
    dom.btnHoldCompare?.classList.add("holding");
    dom.mobBtnHoldCompare?.classList.add("holding");
  };
  const stopCompare = () => {
    dom.overlayLayer?.classList.remove("compare-hidden");
    dom.btnHoldCompare?.classList.remove("holding");
    dom.mobBtnHoldCompare?.classList.remove("holding");
  };

  dom.btnHoldCompare?.addEventListener("mousedown", startCompare);
  dom.btnHoldCompare?.addEventListener("mouseup", stopCompare);
  dom.btnHoldCompare?.addEventListener("mouseleave", stopCompare);
  dom.btnHoldCompare?.addEventListener("touchstart", (e) => {
    e.preventDefault();
    startCompare();
  });
  dom.btnHoldCompare?.addEventListener("touchend", stopCompare);
  dom.btnHoldCompare?.addEventListener("touchcancel", stopCompare);

  dom.mobBtnHoldCompare?.addEventListener("touchstart", (e) => {
    e.preventDefault();
    startCompare();
  });
  dom.mobBtnHoldCompare?.addEventListener("touchend", stopCompare);
  dom.mobBtnHoldCompare?.addEventListener("touchcancel", stopCompare);
  dom.mobBtnHoldCompare?.addEventListener("mousedown", startCompare);
  dom.mobBtnHoldCompare?.addEventListener("mouseup", stopCompare);
  dom.mobBtnHoldCompare?.addEventListener("mouseleave", stopCompare);

  dom.screenImage?.addEventListener("load", () => {
    if (state.blocks.length > 0) {
      renderOverlayLayer();
    }
  });

  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    if (state.blocks.length === 0) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => renderOverlayLayer());
  });

  dom.overlayLayer?.addEventListener("click", (e) => {
    const item = e.target.closest(".ocr-overlay-item");
    if (!item) return;
    const id = item.dataset.id ?? "";
    if (!id) return;

    if (state.displayMode === "inplace") {
      if (state.toggledOriginalIds.has(id)) {
        state.toggledOriginalIds.delete(id);
      } else {
        state.toggledOriginalIds.add(id);
      }
      renderOverlayLayer();
    }
    highlightBlock(id, true);
  });

  dom.overlayLayer?.addEventListener("mouseover", (e) => {
    const item = e.target.closest(".ocr-overlay-item");
    if (!item) return;
    highlightBlock(item.dataset.id ?? "", false);
  });

  dom.textBlocksList?.addEventListener("click", async (e) => {
    const copyBtn = e.target.closest(".copy-icon-btn");
    if (copyBtn) {
      e.stopPropagation();
      const copyId = copyBtn.dataset.copyId ?? "";
      const targetBlk = state.blocks.find((b) => b.id === copyId);
      if (targetBlk?.translated) {
        await navigator.clipboard.writeText(targetBlk.translated);
        showToast(`已复制 ${copyId} 译文`);
      }
      return;
    }

    const card = e.target.closest(".block-card");
    if (card?.dataset?.id) {
      highlightBlock(card.dataset.id, false);
    }
  });

  dom.btnUploadImg?.addEventListener("click", () => dom.fileInput?.click());
  dom.mobBtnUpload?.addEventListener("click", () => dom.fileInput?.click());
  dom.btnTogglePiP?.addEventListener("click", toggleLivePiPMode);
  dom.mobBtnPiP?.addEventListener("click", toggleLivePiPMode);
  dom.btnStopPiPBanner?.addEventListener("click", toggleLivePiPMode);
  dom.btnTranslateLatestShot?.addEventListener("click", triggerLatestScreenshotTranslate);
  dom.fileInput?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleImageFile(file);
    e.target.value = "";
  });

  window.addEventListener("paste", (e) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgItem = items.find((it) => it.type.startsWith("image/"));
    if (imgItem) {
      const file = imgItem.getAsFile();
      if (file) handleImageFile(file);
    }
  });

  dom.btnCapturePc?.addEventListener("click", triggerPcCapture);
  dom.btnLoadDemo?.addEventListener("click", triggerBuiltinDemo);

  dom.btnToggleFrame?.addEventListener("click", () => {
    state.isPhoneFrame = !state.isPhoneFrame;
    dom.deviceViewport?.classList.toggle("phone-frame", state.isPhoneFrame);
    dom.deviceViewport?.classList.toggle("wide-frame", !state.isPhoneFrame);
    if (dom.frameModeLabel) {
      dom.frameModeLabel.textContent = state.isPhoneFrame ? "手机外框视图" : "宽幅桌面视图";
    }
  });

  dom.btnExportImage?.addEventListener("click", () => {
    if (!state.renderedImage) {
      showToast("暂无可导出的翻译图片");
      return;
    }
    const link = document.createElement("a");
    link.href = state.renderedImage;
    link.download = `TransForge_${Date.now()}.png`;
    link.click();
    showToast("已导出 1:1 原位汉化高清图");
  });

  dom.btnCopyAll?.addEventListener("click", async () => {
    if (state.blocks.length === 0) return;
    const allText = state.blocks.map((b) => `${b.id}: ${b.translated ?? ""}`).join("\n");
    await navigator.clipboard.writeText(allText);
    showToast("已复制整屏全部译文到剪贴板");
  });

  dom.btnLiveSync?.addEventListener("click", () => {
    state.isLiveSync = !state.isLiveSync;
    dom.btnLiveSync.classList.toggle("active", state.isLiveSync);
    showToast(state.isLiveSync ? "已开启双端实时同步" : "已暂停双端实时同步");
  });

  dom.mobBtnEngine?.addEventListener("click", () => {
    const order = ["baidu", "google", "tencent"];
    const nextIdx = (order.indexOf(state.activeEngine) + 1) % order.length;
    state.activeEngine = order[nextIdx];
    renderEngineStatusUI();
    showToast(`已切换至 ${dom.mobEngineLabel?.textContent ?? "百度翻译"} 引擎`);
    if (state.originalImage) translateBase64Image(state.originalImage);
  });

  const openApiModal = () => {
    if (dom.cfgActiveEngine) dom.cfgActiveEngine.value = state.activeEngine;
    if (dom.cfgBaiduAppId) dom.cfgBaiduAppId.value = state.config?.baidu?.app_id ?? "";
    if (dom.cfgBaiduAppKey) dom.cfgBaiduAppKey.value = state.config?.baidu?.app_key ?? "";
    if (dom.cfgTencentId) dom.cfgTencentId.value = state.config?.tencent?.secret_id ?? "";
    if (dom.cfgTencentKey) dom.cfgTencentKey.value = state.config?.tencent?.secret_key ?? "";
    dom.apiModal?.classList.remove("hidden");
  };
  const closeApiModal = () => dom.apiModal?.classList.add("hidden");

  dom.btnOpenApiModal?.addEventListener("click", openApiModal);
  dom.btnManageApi?.addEventListener("click", openApiModal);
  dom.btnCloseApiModal?.addEventListener("click", closeApiModal);
  dom.btnCancelApiModal?.addEventListener("click", closeApiModal);

  dom.btnSaveApiConfig?.addEventListener("click", async () => {
    const newPayload = {
      active_engine: dom.cfgActiveEngine?.value ?? "baidu",
      baidu: {
        app_id: (dom.cfgBaiduAppId?.value ?? "").trim(),
        app_key: (dom.cfgBaiduAppKey?.value ?? "").trim()
      },
      tencent: {
        secret_id: (dom.cfgTencentId?.value ?? "").trim(),
        secret_key: (dom.cfgTencentKey?.value ?? "").trim()
      }
    };

    state.config = newPayload;
    state.activeEngine = newPayload.active_engine;
    state.enginesStatus.baidu = {
      configured: Boolean(newPayload.baidu.app_id && newPayload.baidu.app_key),
      label: newPayload.baidu.app_id && newPayload.baidu.app_key ? "Connected" : "Not Configured"
    };
    state.enginesStatus.tencent = {
      configured: Boolean(newPayload.tencent.secret_id && newPayload.tencent.secret_key),
      label: newPayload.tencent.secret_id && newPayload.tencent.secret_key ? "Connected" : "Not Configured"
    };
    localStorage.setItem("transforge_cfg", JSON.stringify(newPayload));

    if (state.backendAvailable) {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newPayload)
      }).catch(() => {});
    }

    renderEngineStatusUI();
    closeApiModal();
    showToast("API 配置已保存并生效");
    if (state.originalImage) translateBase64Image(state.originalImage);
  });

  const openShortcutModal = () => dom.shortcutModal?.classList.remove("hidden");
  const closeShortcutModal = () => dom.shortcutModal?.classList.add("hidden");

  dom.btnOpenShortcutModal?.addEventListener("click", openShortcutModal);
  dom.mobBtnShortcut?.addEventListener("click", openShortcutModal);
  dom.btnCloseShortcutModal?.addEventListener("click", closeShortcutModal);
  dom.btnDoneShortcutModal?.addEventListener("click", closeShortcutModal);

  dom.btnCopyShortcutUrl?.addEventListener("click", async () => {
    const urlText = dom.shortcutUrlCode?.textContent ?? "";
    if (urlText) {
      await navigator.clipboard.writeText(urlText);
      showToast("已复制 iOS 快捷指令专属接口地址");
    }
  });
};

const startLiveSyncLoop = () => {
  setInterval(async () => {
    if (!state.isLiveSync || !state.backendAvailable) return;
    try {
      const resp = await fetch("/api/latest");
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.has_session && data.session?.session_id && data.session.session_id !== state.currentSessionId) {
        applyTranslationSession(data.session);
        showToast("已同步来自手机端的最新实时翻译画面");
      }
    } catch {
      // 忽略轮询异常
    }
  }, 2500);
};

const initApp = async () => {
  bindEvents();
  renderEngineStatusUI();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const infoResp = await fetch("/api/info", { signal: controller.signal });
    clearTimeout(timer);
    if (infoResp.ok) {
      state.backendAvailable = true;
      const info = await infoResp.json();
      state.config = info.config ?? state.config;
      state.activeEngine = info.config?.active_engine ?? state.activeEngine;
      state.sourceLang = info.config?.source_lang ?? "auto";
      state.targetLang = info.config?.target_lang ?? "zh";
      state.enginesStatus = info.engines_status ?? state.enginesStatus;

      if (dom.sourceLangSelect) dom.sourceLangSelect.value = state.sourceLang;
      if (dom.targetLangSelect) dom.targetLangSelect.value = state.targetLang;
      if (dom.shortcutUrlCode && info.shortcut_url) dom.shortcutUrlCode.textContent = info.shortcut_url;
      if (dom.mobileWebUrlCode && info.web_url) dom.mobileWebUrlCode.textContent = info.web_url;

      renderEngineStatusUI();
    }
  } catch {
    state.backendAvailable = false;
  }

  await triggerBuiltinDemo();
  startLiveSyncLoop();
};

document.addEventListener("DOMContentLoaded", initApp);
