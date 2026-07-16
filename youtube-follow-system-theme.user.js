// ==UserScript==
// @name         YouTube 自动跟随系统深浅色模式（完整刷新组件）
// @namespace    youtube-follow-system-theme
// @version      1.3.18
// @description  自动同步系统主题、刷新 YouTube 组件，并为浅色播放页补充实时环境光
// @author       Codex
// @updateURL    https://raw.githubusercontent.com/GavinLeee/Stylus-Cascadea-CSS/main/youtube-follow-system-theme.user.js
// @downloadURL  https://raw.githubusercontent.com/GavinLeee/Stylus-Cascadea-CSS/main/youtube-follow-system-theme.user.js
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const RELOAD_DELAY = 450;
  const RESUME_KEY = 'yt-system-theme-playback-state-v1';
  const LIGHT_AMBIENT_ID = 'yt-light-ambient';
  const LIGHT_AMBIENT_FRAME_DELAY = 90;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  let applying = false;
  let reloadTimer = 0;
  let scrollFrame = 0;
  let channelShelfTimer = 0;
  let lightAmbientTimer = 0;
  let lightAmbientCanvas = null;
  let lightAmbientContext = null;
  let lightAmbientHost = null;
  let observedChannelDockHost = null;
  const channelDockObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    const channelPage = /^\/(?:@|channel\/|c\/|user\/)/.test(location.pathname);
    root.toggleAttribute(
      'data-yt-channel-tabs-stuck',
      Boolean(channelPage && entry && !entry.isIntersecting)
    );
  }, {
    root: null,
    rootMargin: '-56px 0px 0px 0px',
    threshold: 0
  });
  const channelShelfObserver = new MutationObserver((records) => {
    if (!/^\/(?:@|channel\/|c\/|user\/)/.test(location.pathname)) {
      observeChannelDockState();
      return;
    }

    const channelHeaderChanged = records.some((record) =>
      Array.from(record.addedNodes).some((node) =>
        node instanceof Element &&
        (node.matches('ytd-tabbed-page-header') ||
          node.querySelector('ytd-tabbed-page-header'))
      )
    );

    if (channelHeaderChanged || !observedChannelDockHost) {
      observeChannelDockState();
    }

    const relevantSelector = [
      'yt-horizontal-list-renderer',
      'ytd-horizontal-list-renderer',
      'ytd-horizontal-card-list-renderer',
      'yt-lockup-view-model',
      'ytd-grid-video-renderer',
      'ytd-video-renderer',
      '#right-arrow'
    ].join(',');

    const shelfChanged = records.some((record) =>
      Array.from(record.addedNodes).some((node) =>
        node instanceof Element &&
        (node.matches(relevantSelector) || node.querySelector(relevantSelector))
      )
    );

    if (shelfChanged) scheduleChannelVideoShelfExpansion(80);
  });

  function observeChannelDockState(force = false) {
    const channelPage = /^\/(?:@|channel\/|c\/|user\/)/.test(location.pathname);
    const host = channelPage
      ? document.querySelector('ytd-tabbed-page-header')
      : null;

    if (!host) {
      channelDockObserver.disconnect();
      observedChannelDockHost = null;
      root.removeAttribute('data-yt-channel-tabs-stuck');
      return;
    }

    if (!force && observedChannelDockHost === host) return;

    channelDockObserver.disconnect();
    channelDockObserver.observe(host);
    observedChannelDockHost = host;
  }

  function applySystemTheme() {
    if (applying) return;
    applying = true;

    const dark = systemTheme.matches;

    if (root.hasAttribute('dark') !== dark) {
      root.toggleAttribute('dark', dark);
    }

    root.dataset.ytSystemTheme = dark ? 'dark' : 'light';
    root.style.setProperty('color-scheme', dark ? 'dark' : 'light', 'important');
    scheduleLightAmbient(0);

    queueMicrotask(() => {
      applying = false;
    });
  }

  function getMainScrollTop() {
    const candidates = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      document.querySelector('ytd-app'),
      document.querySelector('ytd-page-manager'),
      document.querySelector('#page-manager'),
      document.querySelector('ytd-browse[page-subtype="home"]')
    ];

    return candidates.reduce((maximum, element) => {
      const value = element && Number.isFinite(element.scrollTop)
        ? element.scrollTop
        : 0;
      return Math.max(maximum, value);
    }, window.scrollY || 0);
  }

  function syncMastheadScrollState() {
    scrollFrame = 0;
    root.dataset.ytScrollAware = 'true';
    root.toggleAttribute('data-yt-scrolled', getMainScrollTop() > 8);
  }

  function scheduleMastheadScrollSync() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(syncMastheadScrollState);
  }

  function expandChannelVideoShelves() {
    channelShelfTimer = 0;

    if (!/^\/(?:@|channel\/|c\/|user\/)/.test(location.pathname)) return;

    document.querySelectorAll(
      'yt-horizontal-list-renderer[can-show-more], ' +
      'ytd-horizontal-list-renderer[can-show-more], ' +
      'ytd-horizontal-card-list-renderer[can-show-more]'
    ).forEach((renderer) => {
      if (renderer.hasAttribute('data-yt-apple-native-strip')) return;

      const items = renderer.querySelector('#items');
      const regularVideo = items?.querySelector(
        'yt-lockup-view-model a[href^="/watch"], ' +
        'ytd-grid-video-renderer a[href^="/watch"], ' +
        'ytd-video-renderer a[href^="/watch"]'
      );
      const next = renderer.querySelector('#right-arrow button[aria-label]');

      if (!regularVideo || !next) return;

      renderer.setAttribute('data-yt-apple-native-strip', '');
      renderer.setAttribute('data-yt-apple-preloading-strip', '');
      const initialItemCount = items.children.length;
      next.click();
      restoreExpandedShelfToStart(renderer, initialItemCount, Date.now() + 5000);
    });
  }

  function restoreExpandedShelfToStart(renderer, initialItemCount, deadline) {
    const items = renderer.querySelector('#items');
    const previous = renderer.querySelector('#left-arrow button');
    const expansionFinished = Boolean(
      items &&
      items.children.length > initialItemCount &&
      previous &&
      renderer.hasAttribute('at-end') &&
      /translateX\(\s*-/.test(items.style.transform)
    );

    if (expansionFinished) {
      previous.click();
      confirmExpandedShelfAtStart(renderer, Date.now() + 5000);
      return;
    }

    if (Date.now() < deadline) {
      window.setTimeout(() => {
        restoreExpandedShelfToStart(renderer, initialItemCount, deadline);
      }, 120);
      return;
    }

    renderer.removeAttribute('data-yt-apple-preloading-strip');
    renderer.removeAttribute('data-yt-apple-native-strip');
  }

  function confirmExpandedShelfAtStart(renderer, deadline) {
    const items = renderer.querySelector('#items');
    const inlineTransform = items?.style.transform || '';
    const transformIsAtStart =
      inlineTransform === '' ||
      /translateX\(\s*0(?:px)?\s*\)/.test(inlineTransform);
    const returnedToStart = Boolean(
      items &&
      renderer.hasAttribute('at-start') &&
      !renderer.hasAttribute('at-end') &&
      transformIsAtStart
    );

    if (returnedToStart) {
      renderer.removeAttribute('data-yt-apple-preloading-strip');
      return;
    }

    if (Date.now() < deadline) {
      window.setTimeout(() => {
        confirmExpandedShelfAtStart(renderer, deadline);
      }, 120);
      return;
    }

    /* Keep the zero-offset guard if YouTube has not reported a stable start.
       This is safer than exposing its stale negative transform under the guide. */
    renderer.setAttribute('data-yt-apple-preloading-strip', '');
  }

  function scheduleChannelVideoShelfExpansion(delay = 180) {
    clearTimeout(channelShelfTimer);
    channelShelfTimer = window.setTimeout(expandChannelVideoShelves, delay);
  }

  function isPlayerFullscreen(watchFlexy) {
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      watchFlexy?.hasAttribute('fullscreen') ||
      watchFlexy?.hasAttribute('fullscreen_')
    );
  }

  function removeLightAmbient() {
    document.getElementById(LIGHT_AMBIENT_ID)?.remove();
    lightAmbientCanvas = null;
    lightAmbientContext = null;
    lightAmbientHost = null;
    root.removeAttribute('data-yt-light-ambient');
  }

  function ensureLightAmbient(host) {
    let layer = document.getElementById(LIGHT_AMBIENT_ID);

    if (layer && layer.parentElement !== host) {
      layer.remove();
      layer = null;
    }

    if (!layer) {
      layer = document.createElement('div');
      layer.id = LIGHT_AMBIENT_ID;
      layer.setAttribute('aria-hidden', 'true');

      lightAmbientCanvas = document.createElement('canvas');
      lightAmbientCanvas.width = 160;
      lightAmbientCanvas.height = 90;
      lightAmbientContext = null;
      layer.append(lightAmbientCanvas);
      host.prepend(layer);
    } else {
      lightAmbientCanvas = layer.querySelector('canvas');
    }

    if (!lightAmbientCanvas) return null;

    if (!lightAmbientContext || lightAmbientHost !== host) {
      lightAmbientContext = lightAmbientCanvas.getContext('2d', {
        alpha: true,
        desynchronized: true
      });
      lightAmbientHost = host;

      if (lightAmbientContext) {
        lightAmbientContext.imageSmoothingEnabled = true;
        lightAmbientContext.imageSmoothingQuality = 'low';
      }
    }

    return layer;
  }

  function scheduleLightAmbient(delay = LIGHT_AMBIENT_FRAME_DELAY) {
    clearTimeout(lightAmbientTimer);
    lightAmbientTimer = window.setTimeout(updateLightAmbient, delay);
  }

  function updateLightAmbient() {
    lightAmbientTimer = 0;

    const watchFlexy = document.querySelector('ytd-watch-flexy:not([hidden])');
    const shouldRun =
      !root.hasAttribute('dark') &&
      location.pathname === '/watch' &&
      watchFlexy &&
      !isPlayerFullscreen(watchFlexy);

    if (!shouldRun) {
      removeLightAmbient();
      scheduleLightAmbient(750);
      return;
    }

    const host = watchFlexy.querySelector('#player-container-outer');
    const video = watchFlexy.querySelector('video.html5-main-video, video');

    if (!host || !video) {
      removeLightAmbient();
      scheduleLightAmbient(500);
      return;
    }

    const layer = ensureLightAmbient(host);

    if (
      layer &&
      lightAmbientContext &&
      !document.hidden &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      try {
        lightAmbientContext.drawImage(
          video,
          0,
          0,
          lightAmbientCanvas.width,
          lightAmbientCanvas.height
        );
        layer.dataset.ready = 'true';
        root.dataset.ytLightAmbient = 'true';
      } catch {
        layer.removeAttribute('data-ready');
        root.removeAttribute('data-yt-light-ambient');
      }
    }

    scheduleLightAmbient(
      document.hidden ? 1000 : video.paused ? 350 : LIGHT_AMBIENT_FRAME_DELAY
    );
  }

  function getVideoId(url = new URL(location.href)) {
    return url.pathname === '/watch' ? url.searchParams.get('v') : null;
  }

  function savePlaybackState() {
    const video = document.querySelector('video.html5-main-video, video');
    const videoId = getVideoId();

    if (!video || !videoId || !Number.isFinite(video.currentTime)) return;

    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({
        videoId,
        currentTime: video.currentTime,
        paused: video.paused,
        savedAt: Date.now()
      }));
    } catch {
      /* sessionStorage 不可用时继续刷新，只是不恢复播放位置。 */
    }
  }

  function restorePlaybackState() {
    let state;

    try {
      state = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
      sessionStorage.removeItem(RESUME_KEY);
    } catch {
      return;
    }

    if (
      !state ||
      state.videoId !== getVideoId() ||
      Date.now() - state.savedAt > 30_000
    ) {
      return;
    }

    const deadline = Date.now() + 15_000;
    const restoreTimer = window.setInterval(() => {
      const video = document.querySelector('video.html5-main-video, video');

      if (!video || video.readyState < 1) {
        if (Date.now() > deadline) clearInterval(restoreTimer);
        return;
      }

      clearInterval(restoreTimer);

      if (Math.abs(video.currentTime - state.currentTime) > 1.5) {
        video.currentTime = state.currentTime;
      }

      if (!state.paused) {
        video.play().catch(() => {
          /* 浏览器阻止自动播放时保持暂停，由用户手动继续。 */
        });
      }
    }, 200);
  }

  function reloadForCompleteThemeSwitch() {
    applySystemTheme();
    clearTimeout(reloadTimer);

    reloadTimer = window.setTimeout(() => {
      savePlaybackState();
      location.reload();
    }, RELOAD_DELAY);
  }

  /* 防止 YouTube 在刷新前短暂写回旧的 dark 属性。 */
  const themeObserver = new MutationObserver(() => {
    if (root.hasAttribute('dark') !== systemTheme.matches) {
      applySystemTheme();
    }
  });

  themeObserver.observe(root, {
    attributes: true,
    attributeFilter: ['dark']
  });

  channelShelfObserver.observe(root, {
    childList: true,
    subtree: true
  });

  if (typeof systemTheme.addEventListener === 'function') {
    systemTheme.addEventListener('change', reloadForCompleteThemeSwitch);
  } else {
    systemTheme.addListener(reloadForCompleteThemeSwitch);
  }

  window.addEventListener('scroll', scheduleMastheadScrollSync, { passive: true });
  document.addEventListener('scroll', scheduleMastheadScrollSync, {
    passive: true,
    capture: true
  });
  document.addEventListener('yt-navigate-finish', () => {
    applySystemTheme();
    observeChannelDockState(true);
    scheduleMastheadScrollSync();
    scheduleChannelVideoShelfExpansion(180);
    scheduleLightAmbient(0);
    setTimeout(scheduleMastheadScrollSync, 250);
    setTimeout(() => scheduleChannelVideoShelfExpansion(0), 700);
    setTimeout(() => scheduleChannelVideoShelfExpansion(0), 1600);
    setTimeout(() => scheduleLightAmbient(0), 250);
  }, true);

  document.addEventListener('visibilitychange', () => {
    scheduleLightAmbient(0);
  });

  document.addEventListener('fullscreenchange', () => {
    scheduleLightAmbient(0);
  });

  document.addEventListener('webkitfullscreenchange', () => {
    scheduleLightAmbient(0);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      restorePlaybackState();
      observeChannelDockState(true);
      scheduleMastheadScrollSync();
      scheduleChannelVideoShelfExpansion(180);
      setTimeout(() => scheduleChannelVideoShelfExpansion(0), 900);
    }, { once: true });
  } else {
    restorePlaybackState();
    observeChannelDockState(true);
    scheduleChannelVideoShelfExpansion(180);
  }

  applySystemTheme();
  syncMastheadScrollState();
})();
