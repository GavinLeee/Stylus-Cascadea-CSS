// ==UserScript==
// @name         Apple Podcasts 哈喽怪谈透明播放源
// @namespace    apple-podcasts-source-switcher
// @version      1.2.5
// @description  保留 Apple Podcasts 原生播放与切集体验，仅在后台将《哈喽怪谈》的音频替换为喜马拉雅播放源
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

  const APPLE_SHOW_ID = '512426799';
  const XIMALAYA_ALBUM_ID = '25133280';
  const TRACK_CACHE_KEY = 'ap-hallo-ximalaya-tracks-v2';
  const TRACK_CACHE_MAX_AGE = 12 * 60 * 60 * 1000;
  const AUDIO_CACHE_MAX_AGE = 15 * 60 * 1000;
  const AES_KEY = 'aaad3e4fd540b0f79dca95606e72bf93';

  const attachedAudio = new WeakSet();
  const audioCache = new Map();
  const resolvingAudio = new Map();

  let catalogPromise = null;
  let catalogMemory = null;
  let activeAudio = null;
  let activeTitleKey = '';
  let activeGeneration = 0;
  let pendingTitle = '';
  let desiredPlaying = false;
  let lastExplicitPlayAt = 0;
  let applyingSource = false;
  let appliedTitleKey = '';
  let observer = null;
  let scanQueued = false;
  let playIconTemplate = null;
  let pauseIconTemplate = null;

  function debug(...args) {
    console.debug('[Hallo Ximalaya]', ...args);
  }

  function isHalloPage() {
    return location.pathname.includes(`/id${APPLE_SHOW_ID}`);
  }

  function normalizeTitle(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .replace(/[\p{P}\p{S}\s]+/gu, '');
  }

  function mediaUrl(audio = activeAudio) {
    return audio?.currentSrc || audio?.src || '';
  }

  function isXimalayaUrl(url) {
    return /(?:ximalaya\.com|xmcdn\.com)/i.test(url || '');
  }

  function marqueeTitle() {
    return document.querySelector('[data-testid="marquee-text-item"]')?.textContent?.trim() || '';
  }

  function playerTitle() {
    if (pendingTitle) return pendingTitle;

    const marquee = marqueeTitle();
    if (marquee) return marquee;

    const episodeId = new URL(location.href).searchParams.get('i');
    if (!episodeId) return '';
    const link = [...document.querySelectorAll('a[href*="?i="]')].find((item) => {
      try { return new URL(item.href, location.href).searchParams.get('i') === episodeId; }
      catch { return false; }
    });
    const lockup = link?.querySelector('[data-testid="episode-lockup-title"]')?.textContent?.trim();
    if (lockup) return lockup;

    const slug = decodeURIComponent(location.pathname.split('/').at(-2) || '');
    return slug.replace(/-/g, ' ').trim();
  }

  function syncPlayerTitle(title, previousTitleKey = '') {
    const titleKey = normalizeTitle(title);
    if (!titleKey) return;
    const candidateKeys = new Set([titleKey, previousTitleKey, appliedTitleKey].filter(Boolean));
    for (const node of document.querySelectorAll('[data-testid="marquee-text-item"]')) {
      const currentText = node.textContent?.trim() || '';
      const currentKey = normalizeTitle(currentText);
      if (node.dataset?.halloXimalayaTitle !== '1' && !candidateKeys.has(currentKey)) continue;
      if (node.dataset) node.dataset.halloXimalayaTitle = '1';
      if (currentText !== title) node.textContent = title;
      const button = node.closest?.('button');
      if (button) {
        const label = button.getAttribute('aria-label') || '';
        if (label && currentText && label.includes(currentText)) {
          button.setAttribute('aria-label', label.replace(currentText, title));
        }
      }
    }
  }

  function episodeCardEntries() {
    return [...document.querySelectorAll('[data-testid="episode-wrapper"]')].map((wrapper) => ({
      wrapper,
      title: wrapper.querySelector('[data-testid="episode-lockup-title"]')?.textContent?.trim() || '',
      button: wrapper.querySelector('button[data-testid="hero__play-button"]')
    })).filter((item) => item.title && item.button);
  }

  function cacheButtonIcon(button) {
    const icon = button?.querySelector('[data-testid="button-icon"]');
    if (!icon?.cloneNode) return;
    const label = button.getAttribute('aria-label') || '';
    if (/^Pause\b/i.test(label)) pauseIconTemplate = icon.cloneNode(true);
    else if (/^Play\b/i.test(label) && !playIconTemplate) playIconTemplate = icon.cloneNode(true);
  }

  function replaceButtonIcon(button, template) {
    const icon = button?.querySelector('[data-testid="button-icon"]');
    if (!icon?.replaceWith || !template?.cloneNode) return;
    icon.replaceWith(template.cloneNode(true));
  }

  function setButtonMode(button, playing) {
    if (!button) return;
    cacheButtonIcon(button);
    replaceButtonIcon(button, playing ? pauseIconTemplate : playIconTemplate);
    const label = button.getAttribute('aria-label') || '';
    button.setAttribute('aria-label', label.replace(/^(?:Play|Pause)\b/i, playing ? 'Pause' : 'Play'));
    button.dataset.halloXimalayaManaged = '1';
    button.dataset.halloXimalayaPlaying = playing ? '1' : '0';
  }

  function syncEpisodeCardState(title, playing) {
    const titleKey = normalizeTitle(title);
    if (!titleKey) return;
    const entries = episodeCardEntries();
    for (const item of entries) cacheButtonIcon(item.button);
    const target = entries.find((item) => normalizeTitle(item.title) === titleKey);
    if (!target) return;

    for (const item of entries) {
      const isTarget = item === target;
      const label = item.button.getAttribute('aria-label') || '';
      const wasManaged = item.button.dataset.halloXimalayaManaged === '1';
      if (isTarget) {
        setButtonMode(item.button, playing);
      } else if (/^Pause\b/i.test(label) || wasManaged) {
        setButtonMode(item.button, false);
      }
    }
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

  function readCatalogCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(TRACK_CACHE_KEY) || 'null');
      if (!cached || Date.now() - cached.savedAt > TRACK_CACHE_MAX_AGE) return null;
      return Array.isArray(cached.tracks) ? cached.tracks : null;
    } catch {
      return null;
    }
  }

  function saveCatalogCache(tracks) {
    try {
      localStorage.setItem(TRACK_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), tracks }));
    } catch { /* storage may be restricted */ }
  }

  async function loadCatalog() {
    if (catalogMemory?.length) return catalogMemory;
    const cached = readCatalogCache();
    if (cached?.length) {
      catalogMemory = cached;
      return catalogMemory;
    }
    if (catalogPromise) return catalogPromise;

    catalogPromise = requestJson(
      `https://m.ximalaya.com/m-revision/page/album/queryAlbumPage/${XIMALAYA_ALBUM_ID}?pageSize=1000`
    ).then((payload) => {
      const records = payload?.data?.typeSpecData?.freeOrSingleAlbumData
        ?.albumPageTrackRecords?.trackDetailInfos;
      if (!Array.isArray(records) || !records.length) throw new Error('未取得节目目录');

      const tracks = records.map((record) => ({
        id: String(record?.trackInfo?.id || record?.id || ''),
        title: String(record?.trackInfo?.title || '')
      })).filter((track) => track.id && track.title);
      catalogMemory = tracks;
      saveCatalogCache(tracks);
      debug(`节目目录已更新：${tracks.length} 期`);
      return tracks;
    }).finally(() => { catalogPromise = null; });
    return catalogPromise;
  }

  function matchTrack(tracks, title) {
    const wanted = normalizeTitle(title);
    if (!wanted) return null;

    const exact = tracks.find((track) => normalizeTitle(track.title) === wanted);
    if (exact) return exact;

    return tracks
      .filter((track) => {
        const candidate = normalizeTitle(track.title);
        return candidate.length >= 5
          && Math.abs(candidate.length - wanted.length) <= 6
          && (candidate.includes(wanted) || wanted.includes(candidate));
      })
      .sort((a, b) => Math.abs(normalizeTitle(a.title).length - wanted.length)
        - Math.abs(normalizeTitle(b.title).length - wanted.length))[0] || null;
  }

  function decryptUrl(ciphertext) {
    if (!globalThis.CryptoJS?.AES || !ciphertext) throw new Error('地址解密组件未加载');
    const plaintext = CryptoJS.AES.decrypt(
      { ciphertext: CryptoJS.enc.Base64url.parse(ciphertext) },
      CryptoJS.enc.Hex.parse(AES_KEY),
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    ).toString(CryptoJS.enc.Utf8);
    if (!/^https?:\/\//i.test(plaintext)) throw new Error('播放地址解析失败');
    return plaintext;
  }

  async function fetchAudioUrl(trackId, forceRefresh = false) {
    const cached = audioCache.get(trackId);
    if (!forceRefresh && cached && Date.now() - cached.savedAt < AUDIO_CACHE_MAX_AGE) {
      return cached.url;
    }

    const payload = await requestJson(
      `https://www.ximalaya.com/mobile-playpage/track/v3/baseInfo/${Date.now()}?device=web&trackId=${trackId}&trackQualityLevel=1`
    );
    const playUrls = payload?.trackInfo?.playUrlList;
    if (!Array.isArray(playUrls) || !playUrls.length) throw new Error('未取得播放地址');
    const selected = playUrls.find((item) => item.type === 'M4A_64') || playUrls[0];
    const url = decryptUrl(selected.url);
    audioCache.set(trackId, { url, savedAt: Date.now() });
    return url;
  }

  async function resolveEpisode(title, forceRefresh = false) {
    const key = normalizeTitle(title);
    if (!key) throw new Error('未识别当前节目标题');
    if (!forceRefresh && resolvingAudio.has(key)) return resolvingAudio.get(key);

    const task = (async () => {
      const tracks = await loadCatalog();
      const track = matchTrack(tracks, title);
      if (!track) throw new Error(`未找到对应节目：${title}`);
      const url = await fetchAudioUrl(track.id, forceRefresh);
      return { title: track.title, titleKey: key, trackId: track.id, url };
    })().finally(() => resolvingAudio.delete(key));
    resolvingAudio.set(key, task);
    return task;
  }

  function setEpisode(title, requestPlayback = false) {
    const key = normalizeTitle(title);
    if (!key) return activeGeneration;
    if (key !== activeTitleKey) {
      activeTitleKey = key;
      activeGeneration += 1;
      debug('切换节目', title);
    }
    if (requestPlayback) {
      desiredPlaying = true;
      lastExplicitPlayAt = Date.now();
    }
    return activeGeneration;
  }

  function restoreAndPlay(audio, time, generation, titleKey) {
    const apply = () => {
      if (Number.isFinite(time) && time >= 0 && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(time, Math.max(0, audio.duration - 0.25));
      }
      if (desiredPlaying && generation === activeGeneration && titleKey === activeTitleKey) {
        audio.play().catch((error) => debug('等待用户再次播放', error?.message));
      }
    };
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    else audio.addEventListener('loadedmetadata', apply, { once: true });
  }

  async function useXimalaya(audio, title, generation, forceRefresh = false) {
    if (!audio || !isHalloPage()) return;
    try {
      const resolved = await resolveEpisode(title, forceRefresh);
      if (generation !== activeGeneration || normalizeTitle(playerTitle()) !== resolved.titleKey) {
        debug('忽略已过期的解析结果', resolved.title);
        return;
      }
      if (mediaUrl(audio) === resolved.url) {
        if (desiredPlaying && audio.paused) {
          audio.play().catch((error) => debug('等待用户再次播放', error?.message));
        }
        return;
      }

      const switchedWhileOldEpisodeStillLoaded = isXimalayaUrl(mediaUrl(audio))
        && appliedTitleKey && appliedTitleKey !== resolved.titleKey;
      const previousTitleKey = appliedTitleKey || normalizeTitle(marqueeTitle());
      const resumeTime = switchedWhileOldEpisodeStillLoaded
        ? 0
        : (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
      applyingSource = true;
      audio.pause();
      audio.src = resolved.url;
      audio.load();
      appliedTitleKey = resolved.titleKey;
      syncPlayerTitle(resolved.title, previousTitleKey);
      syncEpisodeCardState(title, desiredPlaying);
      queueMicrotask(() => { applyingSource = false; });
      restoreAndPlay(audio, resumeTime, generation, resolved.titleKey);
      debug('已使用喜马拉雅播放源', resolved.title, resolved.trackId);
    } catch (error) {
      debug('播放源替换失败', title, error?.message || error);
    }
  }

  function prewarm(title) {
    if (!title || !isHalloPage()) return;
    resolveEpisode(title).catch((error) => debug('预解析失败', title, error?.message || error));
  }

  function ensureCurrentSource(requestPlayback = false, forceRefresh = false) {
    const audio = activeAudio;
    const title = playerTitle();
    if (!audio || !title || !isHalloPage()) return;
    const generation = setEpisode(title, requestPlayback);
    useXimalaya(audio, title, generation, forceRefresh);
  }

  function attach(audio) {
    if (!(audio instanceof HTMLMediaElement)) return;
    activeAudio = audio;
    if (attachedAudio.has(audio)) return;
    attachedAudio.add(audio);

    audio.addEventListener('play', () => {
      if (!isHalloPage()) return;
      desiredPlaying = true;
      syncEpisodeCardState(playerTitle(), true);
      if (!isXimalayaUrl(mediaUrl(audio))) ensureCurrentSource(true);
    });

    audio.addEventListener('pause', () => {
      if (!isHalloPage() || applyingSource) return;
      window.setTimeout(() => {
        if (audio.paused && Date.now() - lastExplicitPlayAt > 400) {
          desiredPlaying = false;
          syncEpisodeCardState(playerTitle(), false);
        }
      }, 0);
    });

    audio.addEventListener('loadstart', () => {
      if (!isHalloPage() || applyingSource) return;
      const title = playerTitle();
      if (!title) return;
      setEpisode(title, false);
      if (!isXimalayaUrl(mediaUrl(audio)) && desiredPlaying) {
        ensureCurrentSource(true);
      }
    });

    for (const eventName of ['waiting', 'stalled']) {
      audio.addEventListener(eventName, () => {
        if (isHalloPage() && desiredPlaying && !isXimalayaUrl(mediaUrl(audio))) {
          ensureCurrentSource(true);
        }
      });
    }

    audio.addEventListener('error', () => {
      if (!isHalloPage()) return;
      const failedUrl = mediaUrl(audio);
      if (isXimalayaUrl(failedUrl)) {
        const cached = [...audioCache.entries()].find(([, item]) => item.url === failedUrl);
        if (cached) audioCache.delete(cached[0]);
        ensureCurrentSource(desiredPlaying, true);
      } else {
        ensureCurrentSource(desiredPlaying);
      }
    });
  }

  function scan() {
    scanQueued = false;
    const audio = document.querySelector('#apple-music-player, audio');
    if (audio) attach(audio);
    if (!isHalloPage()) return;

    if (pendingTitle) {
      syncPlayerTitle(pendingTitle);
      syncEpisodeCardState(pendingTitle, desiredPlaying);
    }
    const title = playerTitle();
    if (!title) return;
    const titleChanged = normalizeTitle(title) !== activeTitleKey;
    const generation = setEpisode(title, false);
    if (titleChanged) prewarm(title);

    if (activeAudio && isXimalayaUrl(mediaUrl(activeAudio))) {
      if (appliedTitleKey === normalizeTitle(title)) return;
      if (desiredPlaying) useXimalaya(activeAudio, title, generation);
      return;
    }

    if (activeAudio && desiredPlaying) {
      useXimalaya(activeAudio, title, generation);
    }
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  function start() {
    document.addEventListener('click', (event) => {
      if (!isHalloPage()) return;
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button) return;
      const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim();
      if (button.dataset?.halloXimalayaManaged === '1') {
        event.preventDefault();
        event.stopImmediatePropagation();
      }

      if (/^(?:Pause|暂停)(?:\b|[，,])/i.test(label)) {
        desiredPlaying = false;
        if (activeAudio && !activeAudio.paused) activeAudio.pause();
        syncEpisodeCardState(playerTitle(), false);
        return;
      }

      if (/^(?:Play|播放)(?:\b|[，,])/i.test(label)) {
        let requestedGeneration = activeGeneration;
        const clickedTitle = button.closest('[data-testid="episode-wrapper"]')
          ?.querySelector('[data-testid="episode-lockup-title"]')?.textContent?.trim();
        if (clickedTitle) {
          pendingTitle = clickedTitle;
          const generation = setEpisode(clickedTitle, true);
          requestedGeneration = generation;
          prewarm(clickedTitle);
        } else {
          desiredPlaying = true;
          lastExplicitPlayAt = Date.now();
        }
        window.setTimeout(() => {
          requestAnimationFrame(() => {
            if (desiredPlaying && requestedGeneration === activeGeneration) {
              syncEpisodeCardState(playerTitle(), true);
              ensureCurrentSource(false);
            }
          });
        }, 0);
      }
    }, true);

    observer = new MutationObserver(queueScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
    scan();
    window.setInterval(scan, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
