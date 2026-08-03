// ==UserScript==
// @name         Apple Podcasts 哈喽怪谈透明播放源
// @namespace    apple-podcasts-source-switcher
// @version      1.2.14
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
  let progressTemplate = null;
  let cardReconcileToken = 0;
  let activeProgressContainer = null;
  let activeTopBarsContainer = null;
  let activeHalloContext = false;
  const idleCardMetadata = new Map();

  function debug(...args) {
    console.debug('[Hallo Ximalaya]', ...args);
  }

  function isHalloPage() {
    return location.pathname.includes(`/id${APPLE_SHOW_ID}`);
  }

  function isHalloContext() {
    return isHalloPage() || activeHalloContext;
  }

  function episodeContextFromButton(button) {
    if (!(button instanceof Element)) return null;
    const scope = button.closest(
      '[data-testid="episode-wrapper"], [data-testid="episode-hero"], '
      + '[data-testid="episode-shelf-lockup-container"], a[href*="?i="]'
    );
    if (!scope) return null;

    const link = scope.matches?.('a[href*="?i="]')
      ? scope
      : scope.querySelector?.('a[href*="?i="]');
    if (!link?.href) return null;

    let showId = '';
    try {
      showId = new URL(link.href, location.href).pathname.match(/\/id(\d+)/)?.[1] || '';
    } catch {
      return null;
    }

    const labelledTitle = (link.getAttribute?.('aria-label') || '')
      .split(/\s+Episode\s+[•·]\s+/i)[0]
      .trim();
    const title = scope.querySelector?.('[data-testid="episode-lockup-title"]')?.textContent?.trim()
      || scope.querySelector?.('h3')?.textContent?.trim()
      || labelledTitle;
    return { showId, title, link };
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

  function captureNativeButtonTemplates() {
    for (const { title, wrapper, button } of episodeCardEntries()) {
      const icon = button.querySelector('[data-testid="button-icon"]');
      if (!icon?.cloneNode) continue;
      const label = button.getAttribute('aria-label') || '';
      const progress = button.querySelector('progress[data-testid="progress-bar"]');
      if (progress?.cloneNode) progressTemplate = progress.cloneNode(true);
      if (/^Pause\b/i.test(label) && icon.querySelector('[data-testid="playback-bars"].playing')) {
        pauseIconTemplate = icon.cloneNode(true);
      } else if (!playIconTemplate && /^Play\b/i.test(label)
        && icon.querySelector('[data-testid="invertible-mask-svg"]')) {
        playIconTemplate = icon.cloneNode(true);
      }
      const titleKey = normalizeTitle(title);
      if (/^Play\b/i.test(label) && titleKey && !idleCardMetadata.has(titleKey)) {
        idleCardMetadata.set(titleKey, {
          label,
          text: button.querySelector('[data-testid="hero__play-button-text"]')?.textContent || ''
        });
      }
    }
  }

  function replaceButtonIcon(button, template) {
    const icon = button?.querySelector('[data-testid="button-icon"]');
    if (!icon?.replaceWith || !template?.cloneNode) return false;
    icon.replaceWith(template.cloneNode(true));
    return true;
  }

  function buttonHasPlayingIcon(button) {
    return Boolean(button?.querySelector(
      '[data-testid="button-icon"] [data-testid="playback-bars"].playing'
    ));
  }

  function buttonHasPlayIcon(button) {
    return Boolean(button?.querySelector(
      '[data-testid="button-icon"] [data-testid="invertible-mask-svg"]'
    ));
  }

  function setCardPlayingBars(wrapper, playing) {
    const container = wrapper?.querySelector('.episode-details__playing-bars-inner');
    const bars = container?.querySelector?.('[data-testid="playback-bars"]')
      || wrapper?.querySelector('.episode-details__playing-bars-inner [data-testid="playback-bars"]');
    bars?.classList?.toggle('playing', playing);
  }

  function swapDomNodes(first, second) {
    if (!first || !second || first === second || !first.replaceWith || !second.replaceWith) return false;
    const marker = document.createComment('hallo-ximalaya-swap');
    first.replaceWith(marker);
    second.replaceWith(first);
    marker.replaceWith(second);
    return true;
  }

  function moveActiveContainersTo(target, entries) {
    const targetProgress = target.button.querySelector('.progress-bar');
    const connectedProgress = activeProgressContainer?.isConnected === false
      ? null : activeProgressContainer;
    activeProgressContainer = connectedProgress
      || entries.map((item) => item.button.querySelector('.progress-bar'))
        .find((node) => node?.dataset?.halloXimalayaActiveContainer === '1')
      || targetProgress;
    if (activeProgressContainer && targetProgress && activeProgressContainer !== targetProgress) {
      swapDomNodes(activeProgressContainer, targetProgress);
    }

    const targetTopBars = target.wrapper.querySelector('.episode-details__playing-bars-inner');
    const connectedTopBars = activeTopBarsContainer?.isConnected === false
      ? null : activeTopBarsContainer;
    activeTopBarsContainer = connectedTopBars
      || entries.map((item) => item.wrapper.querySelector('.episode-details__playing-bars-inner'))
        .find((node) => node?.dataset?.halloXimalayaActiveContainer === '1')
      || targetTopBars;
    if (activeTopBarsContainer && targetTopBars && activeTopBarsContainer !== targetTopBars) {
      swapDomNodes(activeTopBarsContainer, targetTopBars);
    }

    for (const item of entries) {
      const progressContainer = item.button.querySelector('.progress-bar');
      const topBarsContainer = item.wrapper.querySelector('.episode-details__playing-bars-inner');
      if (progressContainer?.dataset) delete progressContainer.dataset.halloXimalayaActiveContainer;
      if (topBarsContainer?.dataset) delete topBarsContainer.dataset.halloXimalayaActiveContainer;
    }
    if (activeProgressContainer?.dataset) {
      activeProgressContainer.dataset.halloXimalayaActiveContainer = '1';
    }
    if (activeTopBarsContainer?.dataset) {
      activeTopBarsContainer.dataset.halloXimalayaActiveContainer = '1';
    }
  }

  function removeManagedProgress(button, force = false) {
    const progress = button?.querySelector('progress[data-testid="progress-bar"]');
    if (!progress || (!force && progress.dataset?.halloXimalayaProgress !== '1')) return;
    progress.remove?.();
  }

  function restoreIdleMetadata(item, fallbackLabel = '') {
    const idle = idleCardMetadata.get(normalizeTitle(item.title));
    const label = idle?.label || fallbackLabel.replace(/^(?:Play|Pause)\b/i, 'Play');
    if (label) item.button.setAttribute('aria-label', label);
    const text = item.button.querySelector('[data-testid="hero__play-button-text"]');
    if (text && idle?.text) text.textContent = idle.text;
  }

  function syncActiveCardProgress(item) {
    const audio = activeAudio;
    if (!audio) return;
    const duration = Number(audio.duration);
    const currentTime = Number(audio.currentTime);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return;
    const container = item.button.querySelector('.progress-bar');
    if (!container) return;
    let progress = container.querySelector('progress[data-testid="progress-bar"]');
    if (!progress && progressTemplate?.cloneNode) {
      progress = progressTemplate.cloneNode(true);
      container.append(progress);
    }
    if (!progress) return;
    progress.max = duration;
    progress.value = Math.max(0, Math.min(currentTime, duration));
    progress.setAttribute?.('max', String(duration));
    progress.setAttribute?.('value', String(progress.value));
    progress.dataset.halloXimalayaProgress = '1';
  }

  function syncCurrentCardProgress(title = playerTitle()) {
    const titleKey = normalizeTitle(title);
    const item = episodeCardEntries().find((entry) => normalizeTitle(entry.title) === titleKey);
    if (item) syncActiveCardProgress(item);
  }

  function reconcileNativeCardState(title, playing) {
    captureNativeButtonTemplates();
    if (!playIconTemplate || (playing && !pauseIconTemplate)) return false;
    const titleKey = normalizeTitle(title);
    const entries = episodeCardEntries();
    const target = entries.find((item) => normalizeTitle(item.title) === titleKey);
    if (!target) return false;

    if (playing) moveActiveContainersTo(target, entries);

    // Restore non-target cards after moving the two exact native containers.
    for (const item of entries) {
      if (item === target) continue;
      setCardPlayingBars(item.wrapper, false);
      const label = item.button.getAttribute('aria-label') || '';
      const wasActive = /^Pause\b/i.test(label)
        || buttonHasPlayingIcon(item.button)
        || item.button.dataset.halloXimalayaActive === '1';
      removeManagedProgress(item.button, wasActive);
      if (wasActive || item.button.dataset.halloXimalayaManaged === '1') {
        if (!buttonHasPlayIcon(item.button)) replaceButtonIcon(item.button, playIconTemplate);
        restoreIdleMetadata(item, label);
        item.button.dataset.halloXimalayaManaged = '1';
      }
      delete item.button.dataset.halloXimalayaActive;
    }

    setCardPlayingBars(target.wrapper, playing);
    if (playing ? !buttonHasPlayingIcon(target.button) : !buttonHasPlayIcon(target.button)) {
      replaceButtonIcon(target.button, playing ? pauseIconTemplate : playIconTemplate);
    }
    const targetLabel = target.button.getAttribute('aria-label') || '';
    target.button.setAttribute('aria-label', targetLabel.replace(
      /^(?:Play|Pause)\b/i,
      playing ? 'Pause' : 'Play'
    ));
    target.button.dataset.halloXimalayaManaged = '1';
    if (playing) {
      target.button.dataset.halloXimalayaActive = '1';
      syncActiveCardProgress(target);
    } else {
      delete target.button.dataset.halloXimalayaActive;
    }
    return true;
  }

  function scheduleCardReconcile(title) {
    const titleKey = normalizeTitle(title);
    if (!titleKey) return;
    const token = ++cardReconcileToken;
    for (const delay of [0, 48, 140, 320, 720]) {
      window.setTimeout(() => {
        if (token !== cardReconcileToken || titleKey !== activeTitleKey) return;
        reconcileNativeCardState(title, desiredPlaying && !activeAudio?.paused);
      }, delay);
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
    if (!audio || !isHalloContext()) return;
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
      reconcileNativeCardState(title, desiredPlaying);
      scheduleCardReconcile(title);
      queueMicrotask(() => { applyingSource = false; });
      restoreAndPlay(audio, resumeTime, generation, resolved.titleKey);
      debug('已使用喜马拉雅播放源', resolved.title, resolved.trackId);
    } catch (error) {
      debug('播放源替换失败', title, error?.message || error);
    }
  }

  function prewarm(title) {
    if (!title || !isHalloContext()) return;
    resolveEpisode(title).catch((error) => debug('预解析失败', title, error?.message || error));
  }

  function ensureCurrentSource(requestPlayback = false, forceRefresh = false) {
    const audio = activeAudio;
    const title = playerTitle();
    if (!audio || !title || !isHalloContext()) return;
    const generation = setEpisode(title, requestPlayback);
    useXimalaya(audio, title, generation, forceRefresh);
  }

  function attach(audio) {
    if (!(audio instanceof HTMLMediaElement)) return;
    activeAudio = audio;
    if (attachedAudio.has(audio)) return;
    attachedAudio.add(audio);

    audio.addEventListener('play', () => {
      if (!isHalloContext()) return;
      desiredPlaying = true;
      reconcileNativeCardState(playerTitle(), true);
      if (!isXimalayaUrl(mediaUrl(audio))) ensureCurrentSource(true);
    });

    audio.addEventListener('pause', () => {
      if (!isHalloContext() || applyingSource) return;
      window.setTimeout(() => {
        if (audio.paused && Date.now() - lastExplicitPlayAt > 400) {
          desiredPlaying = false;
          reconcileNativeCardState(playerTitle(), false);
        }
      }, 0);
    });

    audio.addEventListener('loadstart', () => {
      if (!isHalloContext() || applyingSource) return;
      const title = playerTitle();
      if (!title) return;
      setEpisode(title, false);
      if (!isXimalayaUrl(mediaUrl(audio)) && desiredPlaying) {
        ensureCurrentSource(true);
      }
    });

    for (const eventName of ['loadedmetadata', 'durationchange', 'timeupdate']) {
      audio.addEventListener(eventName, () => {
        if (isHalloContext() && desiredPlaying) syncCurrentCardProgress();
      });
    }

    for (const eventName of ['waiting', 'stalled']) {
      audio.addEventListener(eventName, () => {
        if (isHalloContext() && desiredPlaying && !isXimalayaUrl(mediaUrl(audio))) {
          ensureCurrentSource(true);
        }
      });
    }

    audio.addEventListener('error', () => {
      if (!isHalloContext()) return;
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
    if (!isHalloContext()) return;
    captureNativeButtonTemplates();

    if (pendingTitle) {
      syncPlayerTitle(pendingTitle);
      reconcileNativeCardState(pendingTitle, desiredPlaying);
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
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button) return;
      const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim();
      const episodeContext = episodeContextFromButton(button);
      if (episodeContext) {
        activeHalloContext = episodeContext.showId === APPLE_SHOW_ID;
        if (!activeHalloContext) {
          pendingTitle = '';
          desiredPlaying = false;
          return;
        }
      } else if (!isHalloContext()) {
        return;
      }
      if (/^(?:Pause|暂停)(?:\b|[，,])/i.test(label)) {
        desiredPlaying = false;
        if (activeAudio && !activeAudio.paused) activeAudio.pause();
        reconcileNativeCardState(playerTitle(), false);
        return;
      }

      if (/^(?:Play|播放)(?:\b|[，,])/i.test(label)) {
        let requestedGeneration = activeGeneration;
        const clickedTitle = episodeContext?.title
          || button.closest('[data-testid="episode-wrapper"]')
            ?.querySelector('[data-testid="episode-lockup-title"]')?.textContent?.trim();
        if (clickedTitle) {
          pendingTitle = clickedTitle;
          const generation = setEpisode(clickedTitle, true);
          requestedGeneration = generation;
          prewarm(clickedTitle);
          scheduleCardReconcile(clickedTitle);
        } else {
          desiredPlaying = true;
          lastExplicitPlayAt = Date.now();
        }
        window.setTimeout(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (desiredPlaying && requestedGeneration === activeGeneration) {
                reconcileNativeCardState(playerTitle(), true);
                ensureCurrentSource(false);
              }
            });
          });
        }, 48);
      }
    }, true);

    observer = new MutationObserver(() => {
      captureNativeButtonTemplates();
      queueScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
    captureNativeButtonTemplates();
    scan();
    window.setInterval(scan, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
