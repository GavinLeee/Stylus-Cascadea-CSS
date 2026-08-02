// ==UserScript==
// @name         Apple Podcasts 播放源自动切换
// @namespace    apple-podcasts-source-switcher
// @version      1.0.0
// @description  原播放源失败时自动切换到已匹配的喜马拉雅音频，并提供苹果风手动播放源控件
// @author       Codex
// @match        https://podcasts.apple.com/*
// @run-at       document-start
// @grant        none
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
    })
  });

  const MODE_KEY = 'ap-source-switcher-mode';
  const AUTO_TIMEOUT_MS = 9000;
  const RETRY_TIMEOUT_MS = 6500;
  const attachedAudio = new WeakSet();
  const originalUrl = new WeakMap();

  let mode = readMode();
  let activeAudio = null;
  let activeMapping = null;
  let currentProvider = 'apple';
  let watchdog = 0;
  let lastUrl = '';
  let controlHost = null;
  let controlRoot = null;
  let lastPlayIntentAt = 0;

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

  function mappingFor(audio = activeAudio) {
    const byUrl = SOURCE_MAP[episodeIdFromLocation()];
    if (byUrl) return byUrl;
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
    if (mode !== 'auto' || !mappingFor(audio) || isXimalayaUrl(mediaUrl(audio))) return;
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
    if (mode === 'ximalaya') switchToXimalaya(activeAudio, '固定使用喜马拉雅');
    else switchToApple(activeAudio);
  }

  function attachAudio(audio) {
    if (!(audio instanceof HTMLMediaElement)) return;
    activeAudio = audio;
    if (Date.now() - lastPlayIntentAt < 15000) audio.dataset.apSourcePlayIntent = '1';
    const detectedMapping = mappingFor(audio);
    if (!detectedMapping) return;
    activeMapping = detectedMapping;
    ensureControl();

    if (!originalUrl.has(audio) && !isXimalayaUrl(mediaUrl(audio))) {
      originalUrl.set(audio, mediaUrl(audio) || activeMapping.appleUrl);
    }
    if (attachedAudio.has(audio)) {
      if (mode === 'ximalaya' && !isXimalayaUrl(mediaUrl(audio))) switchToXimalaya(audio);
      return;
    }
    attachedAudio.add(audio);

    audio.addEventListener('loadstart', () => {
      activeAudio = audio;
      const nextMapping = mappingFor(audio);
      if (!nextMapping && !isXimalayaUrl(mediaUrl(audio))) {
        originalUrl.delete(audio);
        activeMapping = null;
        ensureControl();
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
        switchToXimalaya(audio, '原播放源失败，已自动切换', audio.dataset.apSourcePlayIntent === '1');
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

    if (mode === 'ximalaya') switchToXimalaya(audio, '固定使用喜马拉雅');
    else {
      currentProvider = isXimalayaUrl(mediaUrl(audio)) ? 'ximalaya' : 'apple';
      updateControl();
      if (mode === 'auto' && audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) armWatchdog(audio);
    }
  }

  function ensureControl() {
    const mapping = mappingFor() || activeMapping || SOURCE_MAP[episodeIdFromLocation()];
    if (!mapping) {
      controlHost?.remove();
      controlHost = null;
      controlRoot = null;
      return;
    }
    activeMapping = mapping;
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
    if (activeMapping) ensureControl();
  }

  function start() {
    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button) return;
      const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim();
      if (/^(?:Play|播放)(?:\b|[，,])/i.test(label)) {
        lastPlayIntentAt = Date.now();
        if (activeAudio) activeAudio.dataset.apSourcePlayIntent = '1';
      }
    }, true);
    scan();
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(scan, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
