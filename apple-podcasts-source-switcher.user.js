// ==UserScript==
// @name         Apple Podcasts 播放源自动切换
// @namespace    apple-podcasts-source-switcher
// @version      1.1.0
// @description  《哈喽怪谈》原播放源失败时，按节目标题自动匹配喜马拉雅整档音频，并提供苹果风手动播放源控件
// @author       Codex
// @match        https://podcasts.apple.com/*
// @run-at       document-start
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @grant        GM_xmlhttpRequest
// @connect      m.ximalaya.com
// @connect      www.ximalaya.com
// @updateURL    https://raw.githubusercontent.com/GavinLeee/Stylus-Cascadea-CSS/main/apple-podcasts-source-switcher.user.js
// @downloadURL  https://raw.githubusercontent.com/GavinLeee/Stylus-Cascadea-CSS/main/apple-podcasts-source-switcher.user.js
// ==/UserScript==

(() => {
  'use strict';

  const SOURCE_MAP = Object.freeze({
    // Apple Podcasts: 快递外卖怪事多——影榴莲
    // Ximalaya: album 25133280 / track 1001881016 / 03:04:37
    '1000777812880': Object.freeze({
      title: '快递外卖怪事多——影榴莲',
      appleUrl: 'https://tk.wavpub.com/WPDL_kyAEYpYwxGhJvvqhXQLejeaRVaWCsJPNhqcBngYZLurVTfbSjDejZPqxrH-87.mp3',
      appleToken: 'WPDL_kyAEYpYwxGhJvvqhXQLejeaRVaWCsJPNhqcBngYZLurVTfbSjDejZPqxrH-87',
      ximalayaTrackId: '1001881016',
      ximalayaUrl: 'https://jt.ximalaya.com//GKwRIDoOM2hABVhLkwS50N5I.m4a?channel=rss&album_id=25133280&track_id=1001881016&uid=1029792&jt=https://aod.cos.tx.xmcdn.com/storages/3e04-audiofreehighqps/3F/C2/GKwRIDoOM2hABVhLkwS50N5I.m4a'
    }),
    // Apple Podcasts: 禁忌游戏 上——影榴莲
    // Ximalaya: album 25133280 / track 1003109714 / 02:46:05
    '1000778499442': Object.freeze({
      title: '禁忌游戏 上——影榴莲',
      appleUrl: 'https://tk.wavpub.com/WPDL_FksRvthygsMQesmSQQSGEfnhqMXPvfmAGtFSashKHhqJaBRNHNJJSueHLQ-61.mp3',
      appleToken: 'WPDL_FksRvthygsMQesmSQQSGEfnhqMXPvfmAGtFSashKHhqJaBRNHNJJSueHLQ-61',
      ximalayaTrackId: '1003109714',
      ximalayaUrl: 'https://jt.ximalaya.com//GKwRIW4OPKQSBM7x6gS9rplk.m4a?channel=rss&album_id=25133280&track_id=1003109714&uid=1029792&jt=https://aod.cos.tx.xmcdn.com/storages/f935-audiofreehighqps/BD/9C/GKwRIW4OPKQSBM7x6gS9rplk.m4a'
    })
  });

  const MODE_KEY = 'ap-source-switcher-mode';
  const HALLO_APPLE_SHOW_ID = '512426799';
  const HALLO_XIMALAYA_ALBUM_ID = '25133280';
  const HALLO_TRACK_CACHE_KEY = 'ap-hallo-ximalaya-tracks-v1';
  const HALLO_TRACK_CACHE_MAX_AGE = 12 * 60 * 60 * 1000;
  const XIMALAYA_AES_KEY = 'aaad3e4fd540b0f79dca95606e72bf93';
  const AUTO_TIMEOUT_MS = 9000;
  const RETRY_TIMEOUT_MS = 6500;
  const attachedAudio = new WeakSet();
  const originalUrl = new WeakMap();
  const dynamicMappings = new Map();
  const resolvingTitles = new Map();

  let mode = readMode();
  let activeAudio = null;
  let activeMapping = null;
  let currentProvider = 'apple';
  let watchdog = 0;
  let lastUrl = '';
  let controlHost = null;
  let controlRoot = null;
  let lastPlayIntentAt = 0;
  let halloTracksPromise = null;
  let pendingEpisodeTitle = '';
  let pendingEpisodeTitleAt = 0;

  function readMode() {
    try {
      const saved = sessionStorage.getItem(MODE_KEY);
      return ['auto', 'apple', 'ximalaya'].includes(saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  }

  function saveMode(nextMode) {
    try { sessionStorage.setItem(MODE_KEY, nextMode); } catch { /* restricted storage */ }
  }

  function episodeIdFromLocation() {
    try { return new URL(location.href).searchParams.get('i') || ''; }
    catch { return ''; }
  }

  function mediaUrl(audio) {
    return audio?.currentSrc || audio?.src || '';
  }

  function isHalloPage() {
    return location.pathname.includes(`/id${HALLO_APPLE_SHOW_ID}`)
      || document.title.includes('哈喽怪谈');
  }

  function normalizeTitle(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .replace(/[\p{P}\p{S}\s]+/gu, '');
  }

  function currentEpisodeTitle() {
    if (pendingEpisodeTitle && Date.now() - pendingEpisodeTitleAt < 15000) {
      return pendingEpisodeTitle;
    }
    const playerTitle = document.querySelector('[data-testid="marquee-text-item"]')?.textContent?.trim();
    if (playerTitle) return playerTitle;

    const episodeId = episodeIdFromLocation();
    if (episodeId) {
      const link = [...document.querySelectorAll('a[href*="?i="]')]
        .find((item) => new URL(item.href, location.href).searchParams.get('i') === episodeId);
      const lockupTitle = link?.querySelector('[data-testid="episode-lockup-title"]')?.textContent?.trim();
      if (lockupTitle) return lockupTitle;

      const slug = decodeURIComponent(location.pathname.split('/').at(-2) || '');
      if (slug) return slug.replace(/-/g, ' ');
    }
    return '';
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 20000,
        headers: { Accept: 'application/json, text/plain, */*' },
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          try { resolve(JSON.parse(response.responseText)); }
          catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error('网络请求超时'))
      });
    });
  }

  function readHalloTrackCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(HALLO_TRACK_CACHE_KEY) || 'null');
      if (!cached || Date.now() - cached.savedAt > HALLO_TRACK_CACHE_MAX_AGE) return null;
      return Array.isArray(cached.tracks) ? cached.tracks : null;
    } catch {
      return null;
    }
  }

  function saveHalloTrackCache(tracks) {
    try {
      localStorage.setItem(HALLO_TRACK_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), tracks }));
    } catch { /* restricted storage */ }
  }

  async function loadHalloTracks() {
    const cached = readHalloTrackCache();
    if (cached?.length) return cached;
    if (halloTracksPromise) return halloTracksPromise;

    halloTracksPromise = requestJson(
      `https://m.ximalaya.com/m-revision/page/album/queryAlbumPage/${HALLO_XIMALAYA_ALBUM_ID}?pageSize=1000`
    ).then((payload) => {
      const records = payload?.data?.typeSpecData?.freeOrSingleAlbumData
        ?.albumPageTrackRecords?.trackDetailInfos;
      if (!Array.isArray(records) || !records.length) throw new Error('未取得喜马拉雅节目列表');
      const tracks = records.map((record) => ({
        id: String(record?.trackInfo?.id || record?.id || ''),
        title: String(record?.trackInfo?.title || '')
      })).filter((track) => track.id && track.title);
      saveHalloTrackCache(tracks);
      return tracks;
    }).finally(() => { halloTracksPromise = null; });
    return halloTracksPromise;
  }

  function decryptXimalayaUrl(ciphertext) {
    if (!globalThis.CryptoJS?.AES || !ciphertext) throw new Error('音频地址解密组件未加载');
    return CryptoJS.AES.decrypt(
      { ciphertext: CryptoJS.enc.Base64url.parse(ciphertext) },
      CryptoJS.enc.Hex.parse(XIMALAYA_AES_KEY),
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    ).toString(CryptoJS.enc.Utf8);
  }

  async function fetchXimalayaAudio(trackId) {
    const payload = await requestJson(
      `https://www.ximalaya.com/mobile-playpage/track/v3/baseInfo/${Date.now()}?device=web&trackId=${trackId}&trackQualityLevel=1`
    );
    const playUrls = payload?.trackInfo?.playUrlList;
    if (!Array.isArray(playUrls) || !playUrls.length) throw new Error('未取得喜马拉雅播放地址');
    const selected = playUrls.find((item) => item.type === 'M4A_64') || playUrls[0];
    const url = decryptXimalayaUrl(selected.url);
    if (!/^https?:\/\//i.test(url)) throw new Error('喜马拉雅播放地址无效');
    return url;
  }

  function findHalloTrack(tracks, title) {
    const wanted = normalizeTitle(title);
    if (!wanted) return null;
    const exact = tracks.find((track) => normalizeTitle(track.title) === wanted);
    if (exact) return exact;
    return tracks
      .filter((track) => {
        const candidate = normalizeTitle(track.title);
        return candidate.length >= 5 && (candidate.includes(wanted) || wanted.includes(candidate));
      })
      .sort((a, b) => normalizeTitle(b.title).length - normalizeTitle(a.title).length)[0] || null;
  }

  async function resolveHalloMapping(audio = activeAudio) {
    if (!isHalloPage() || !audio) return null;
    const title = currentEpisodeTitle();
    const key = normalizeTitle(title);
    if (!key) return null;
    if (dynamicMappings.has(key)) return dynamicMappings.get(key);
    if (resolvingTitles.has(key)) return resolvingTitles.get(key);

    ensureControl();
    updateControl('正在匹配喜马拉雅…');
    const task = (async () => {
      const tracks = await loadHalloTracks();
      const track = findHalloTrack(tracks, title);
      if (!track) throw new Error(`未找到对应节目：${title}`);
      const ximalayaUrl = await fetchXimalayaAudio(track.id);
      const mapping = Object.freeze({
        title,
        appleUrl: mediaUrl(audio),
        appleToken: '',
        ximalayaTrackId: track.id,
        ximalayaUrl
      });
      dynamicMappings.set(key, mapping);
      activeMapping = mapping;
      pendingEpisodeTitle = '';
      if (!originalUrl.has(audio) && !isXimalayaUrl(mediaUrl(audio))) {
        originalUrl.set(audio, mediaUrl(audio));
      }
      updateControl(`已匹配：${track.title}`);
      if (mode === 'ximalaya'
        || (mode === 'auto' && audio.dataset.apSourcePlayIntent === '1'
          && (audio.error || audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA))) {
        switchToXimalaya(audio, '已自动匹配喜马拉雅', true);
      }
      return mapping;
    })().catch((error) => {
      updateControl(error?.message || '自动匹配失败');
      return null;
    }).finally(() => resolvingTitles.delete(key));
    resolvingTitles.set(key, task);
    return task;
  }

  function mappingFor(audio = activeAudio) {
    const byUrl = SOURCE_MAP[episodeIdFromLocation()];
    if (byUrl) return byUrl;
    const dynamic = dynamicMappings.get(normalizeTitle(currentEpisodeTitle()));
    if (dynamic) return dynamic;
    const src = mediaUrl(audio);
    if (!src) return null;
    return Object.values(SOURCE_MAP).find((item) => src.includes(item.appleToken)) || null;
  }

  function isXimalayaUrl(url) {
    return /(?:ximalaya\.com|xmcdn\.com)/i.test(url || '');
  }

  function clearWatchdog() {
    if (watchdog) window.clearTimeout(watchdog);
    watchdog = 0;
  }

  function armWatchdog(audio, delay = AUTO_TIMEOUT_MS) {
    clearWatchdog();
    if (mode !== 'auto' || isXimalayaUrl(mediaUrl(audio))) return;
    if (!mappingFor(audio)) {
      resolveHalloMapping(audio).then((mapping) => {
        if (mapping) armWatchdog(audio, delay);
      });
      return;
    }
    if (audio.paused && audio.dataset.apSourcePlayIntent !== '1') return;
    const observedTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    watchdog = window.setTimeout(() => {
      const hasNotProgressed = !Number.isFinite(audio.currentTime)
        || Math.abs(audio.currentTime - observedTime) < 0.25;
      if (mode === 'auto' && audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA && hasNotProgressed) {
        switchToXimalaya(audio, '原播放源连接超时，已自动切换', true);
      }
    }, delay);
  }

  function updateControl(statusText = '') {
    if (!controlRoot) return;
    controlRoot.querySelectorAll('button[data-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === mode);
    });
    const provider = controlRoot.querySelector('.provider');
    const status = controlRoot.querySelector('.status');
    if (provider) {
      provider.textContent = currentProvider === 'ximalaya' ? '喜马拉雅' : 'Apple';
      provider.dataset.provider = currentProvider;
    }
    if (status) status.textContent = statusText || (mode === 'auto' ? '自动检测' : '手动选择');
  }

  function restorePositionAndPlay(audio, time, shouldPlay) {
    const apply = () => {
      if (Number.isFinite(time) && time > 0 && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(time, Math.max(0, audio.duration - 0.25));
      }
      if (shouldPlay) audio.play().catch(() => {});
    };
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    else audio.addEventListener('loadedmetadata', apply, { once: true });
  }

  function replaceSource(audio, url, provider, statusText, forcePlay = false) {
    if (!audio || !url || mediaUrl(audio) === url) {
      currentProvider = provider;
      updateControl(statusText);
      return;
    }
    const resumeTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const shouldPlay = forcePlay || !audio.paused || audio.dataset.apSourcePlayIntent === '1';
    clearWatchdog();
    audio.pause();
    audio.src = url;
    audio.load();
    currentProvider = provider;
    updateControl(statusText);
    restorePositionAndPlay(audio, resumeTime, shouldPlay);
  }

  function switchToXimalaya(audio = activeAudio, reason = '已切换到喜马拉雅', forcePlay = false) {
    const mapping = mappingFor(audio);
    if (!audio || !mapping) {
      updateControl('请先点击本集的播放按钮');
      return;
    }
    if (!originalUrl.has(audio)) originalUrl.set(audio, mediaUrl(audio) || mapping.appleUrl);
    activeMapping = mapping;
    replaceSource(audio, mapping.ximalayaUrl, 'ximalaya', reason, forcePlay);
  }

  function switchToApple(audio = activeAudio) {
    const mapping = mappingFor(audio) || activeMapping;
    if (!audio || !mapping) {
      updateControl('请先点击本集的播放按钮');
      return;
    }
    replaceSource(audio, originalUrl.get(audio) || mapping.appleUrl, 'apple', '使用 Apple 原播放源');
    if (mode === 'auto') armWatchdog(audio);
  }

  function applyMode() {
    if (!activeAudio) {
      updateControl('请先点击本集的播放按钮');
      return;
    }
    if (mode === 'ximalaya' && !mappingFor(activeAudio)) {
      resolveHalloMapping(activeAudio).then((mapping) => {
        if (mapping) switchToXimalaya(activeAudio, '固定使用喜马拉雅', true);
      });
    } else if (mode === 'ximalaya') switchToXimalaya(activeAudio, '固定使用喜马拉雅');
    else switchToApple(activeAudio);
  }

  function attachAudio(audio) {
    if (!(audio instanceof HTMLMediaElement)) return;
    activeAudio = audio;
    if (Date.now() - lastPlayIntentAt < 15000) audio.dataset.apSourcePlayIntent = '1';
    const detectedMapping = mappingFor(audio);
    if (!detectedMapping && !isHalloPage()) return;
    activeMapping = detectedMapping || null;
    ensureControl();
    if (!detectedMapping) resolveHalloMapping(audio);

    if (!originalUrl.has(audio) && !isXimalayaUrl(mediaUrl(audio))) {
      originalUrl.set(audio, mediaUrl(audio) || activeMapping?.appleUrl || '');
    }
    if (attachedAudio.has(audio)) {
      if (mode === 'ximalaya' && !isXimalayaUrl(mediaUrl(audio))) {
        if (mappingFor(audio)) switchToXimalaya(audio);
        else resolveHalloMapping(audio);
      }
      return;
    }
    attachedAudio.add(audio);

    audio.addEventListener('loadstart', () => {
      activeAudio = audio;
      const nextMapping = mappingFor(audio);
      if (!nextMapping && !isXimalayaUrl(mediaUrl(audio))) {
        if (!originalUrl.has(audio)) originalUrl.set(audio, mediaUrl(audio));
        activeMapping = null;
        ensureControl();
        resolveHalloMapping(audio);
        return;
      }
      activeMapping = nextMapping || activeMapping;
      if (!isXimalayaUrl(mediaUrl(audio)) && !originalUrl.has(audio)) {
        originalUrl.set(audio, mediaUrl(audio) || activeMapping?.appleUrl || '');
      }
      if (mode === 'ximalaya') switchToXimalaya(audio, '固定使用喜马拉雅');
      else if (mode === 'auto') armWatchdog(audio);
    });
    audio.addEventListener('play', () => {
      audio.dataset.apSourcePlayIntent = '1';
      if (!mappingFor(audio)) resolveHalloMapping(audio);
      if (mode === 'auto') armWatchdog(audio);
    });
    audio.addEventListener('playing', () => {
      audio.dataset.apSourcePlayIntent = '0';
      clearWatchdog();
      currentProvider = isXimalayaUrl(mediaUrl(audio)) ? 'ximalaya' : 'apple';
      updateControl('正在播放');
    });
    audio.addEventListener('canplay', clearWatchdog);
    audio.addEventListener('pause', () => {
      if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) audio.dataset.apSourcePlayIntent = '0';
    });
    audio.addEventListener('error', () => {
      if (mode === 'auto' && !isXimalayaUrl(mediaUrl(audio))) {
        const mapping = mappingFor(audio);
        if (mapping) {
          switchToXimalaya(audio, '原播放源失败，已自动切换', audio.dataset.apSourcePlayIntent === '1');
        } else {
          resolveHalloMapping(audio);
        }
      } else {
        clearWatchdog();
        updateControl('当前播放源加载失败');
      }
    });
    for (const eventName of ['stalled', 'waiting']) {
      audio.addEventListener(eventName, () => {
        if (mode === 'auto' && !isXimalayaUrl(mediaUrl(audio))) armWatchdog(audio, RETRY_TIMEOUT_MS);
      });
    }

    if (mode === 'ximalaya' && mappingFor(audio)) switchToXimalaya(audio, '固定使用喜马拉雅');
    else if (mode === 'ximalaya') resolveHalloMapping(audio);
    else {
      currentProvider = isXimalayaUrl(mediaUrl(audio)) ? 'ximalaya' : 'apple';
      updateControl();
      if (mode === 'auto' && audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) armWatchdog(audio);
    }
  }

  function ensureControl() {
    const mapping = mappingFor() || activeMapping || SOURCE_MAP[episodeIdFromLocation()];
    if (!mapping && !isHalloPage()) {
      controlHost?.remove();
      controlHost = null;
      controlRoot = null;
      return;
    }
    if (mapping) activeMapping = mapping;
    if (controlHost?.isConnected) return;

    controlHost = document.createElement('div');
    controlHost.id = 'ap-source-switcher-host';
    controlHost.setAttribute('aria-label', '播放源切换');
    controlRoot = controlHost.attachShadow({ mode: 'open' });
    controlRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .panel { position: fixed; right: 22px; bottom: max(88px, calc(env(safe-area-inset-bottom) + 78px)); z-index: 2147483000; display: grid; gap: 7px; padding: 8px; border: 1px solid rgb(15 23 42 / 10%); border-radius: 18px; color: #1d1d1f; background: rgb(250 250 252 / 78%); box-shadow: 0 12px 34px rgb(15 23 42 / 14%), 0 2px 8px rgb(15 23 42 / 7%); -webkit-backdrop-filter: blur(26px) saturate(165%); backdrop-filter: blur(26px) saturate(165%); font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; }
        .row { display: flex; align-items: center; gap: 6px; }
        button { appearance: none; border: 0; border-radius: 11px; padding: 7px 10px; color: inherit; background: transparent; font: inherit; cursor: pointer; transition: transform 180ms cubic-bezier(.2,.8,.2,1), background-color 180ms ease, box-shadow 180ms ease; }
        button:hover { transform: translateY(-1px) scale(1.025); background: rgb(120 120 128 / 10%); }
        button:active { transform: scale(.96); }
        button.active { background: rgb(255 255 255 / 92%); box-shadow: 0 2px 8px rgb(15 23 42 / 12%); }
        .meta { justify-content: space-between; padding: 0 6px 1px; color: #6e6e73; font-size: 10px; font-weight: 550; }
        .provider::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: #8e8e93; }
        .provider[data-provider="ximalaya"]::before { background: #34c759; }
        @media (prefers-color-scheme: dark) { .panel { color: #f5f5f7; border-color: rgb(255 255 255 / 11%); background: rgb(32 32 36 / 76%); box-shadow: 0 16px 38px rgb(0 0 0 / 35%); } button:hover { background: rgb(255 255 255 / 9%); } button.active { background: rgb(255 255 255 / 16%); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 7%), 0 2px 8px rgb(0 0 0 / 22%); } .meta { color: #aeaeb2; } }
        @media (max-width: 720px) { .panel { right: 10px; bottom: max(82px, calc(env(safe-area-inset-bottom) + 72px)); } button { padding-inline: 8px; } }
      </style>
      <div class="panel">
        <div class="row"><button type="button" data-mode="auto">自动</button><button type="button" data-mode="apple">Apple</button><button type="button" data-mode="ximalaya">喜马拉雅</button></div>
        <div class="row meta"><span class="provider" data-provider="apple">Apple</span><span class="status">自动检测</span></div>
      </div>`;

    controlRoot.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-mode]');
      if (!button) return;
      mode = button.dataset.mode;
      saveMode(mode);
      updateControl();
      applyMode();
    });
    (document.body || document.documentElement).appendChild(controlHost);
    updateControl();
  }

  function scan() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      activeMapping = SOURCE_MAP[episodeIdFromLocation()] || null;
      if (!activeMapping && activeAudio) activeMapping = mappingFor(activeAudio);
      ensureControl();
    }
    document.querySelectorAll('audio').forEach(attachAudio);
    if (activeMapping || isHalloPage()) ensureControl();
  }

  function start() {
    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button) return;
      const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim();
      if (/^(?:Play|播放)(?:\b|[，,])/i.test(label)) {
        lastPlayIntentAt = Date.now();
        const clickedTitle = button.closest('[data-testid="episode-wrapper"]')
          ?.querySelector('[data-testid="episode-lockup-title"]')?.textContent?.trim();
        if (clickedTitle) {
          pendingEpisodeTitle = clickedTitle;
          pendingEpisodeTitleAt = Date.now();
        }
        if (activeAudio) activeAudio.dataset.apSourcePlayIntent = '1';
        window.setTimeout(() => resolveHalloMapping(activeAudio), 0);
      }
    }, true);
    scan();
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(scan, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
