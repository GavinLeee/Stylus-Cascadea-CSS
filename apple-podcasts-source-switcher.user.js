// ==UserScript==
// @name         Apple Podcasts 哈喽怪谈透明播放源
// @namespace    apple-podcasts-source-switcher
// @version      1.2.32
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
  /* 每集听到哪儿：切回旧剧集时要从这里续播，而不是从头开始（原生行为）。
     键是归一化标题，值是 { time, duration }，并持久化到 localStorage，
     刷新页面后仍能显示进度与续播。 */
  const episodePositions = new Map();
  const POSITION_CACHE_KEY = 'ap-hallo-episode-positions-v1';
  let positionSaveTimer = 0;

  function loadEpisodePositions() {
    try {
      const raw = JSON.parse(localStorage.getItem(POSITION_CACHE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return;
      for (const [key, value] of Object.entries(raw)) {
        const time = Number(value?.time) || 0;
        if (!key || time <= 0) continue;
        episodePositions.set(key, { time, duration: Number(value?.duration) || 0 });
      }
    } catch { /* 存储不可用时退回内存态 */ }
  }

  function saveEpisodePositions() {
    clearTimeout(positionSaveTimer);
    positionSaveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          POSITION_CACHE_KEY,
          JSON.stringify(Object.fromEntries(episodePositions))
        );
      } catch { /* 存储不可用时忽略 */ }
    }, 1000);
  }

  let catalogPromise = null;
  let catalogMemory = null;
  let activeAudio = null;
  let activeTitleKey = '';
  let activeGeneration = 0;
  let pendingTitle = '';
  let desiredPlaying = false;
  let pendingPlaybackGeneration = 0;
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
  let userPaused = false;
  const idleCardMetadata = new Map();

  /* 卡片状态校正：不再用一串写死的延迟去赌 Svelte 什么时候重渲染完，而是反复
     校正到"实测状态已正确"为止，最长不超过这个窗口。每次重排后都会重新认领
     当前有效的原生节点，因此中途 Svelte 重建卡片也能被纠正回来。 */
  const CARD_RECONCILE_WINDOW = 2000;
  const CARD_RECONCILE_INTERVAL = 60;

  function debug(...args) {
    console.debug('[Hallo Ximalaya]', ...args);
  }

  /*
   * 把 DOM 写操作挪出事件派发过程。
   *
   * 本脚本的点击监听挂在 capture 阶段（早于 Apple 自己的处理器）。实测：在 Home
   * 页点别的播客时，点击变成了整页跳转到该剧集页、且跳转后什么都没播——那类卡片
   * 的播放键嵌在 a[href*="?i="] 里，本该由 Apple 的处理器 preventDefault() 拦下，
   * 我们在派发途中同步改 DOM 把它打断了。
   *
   * 但整个处理器都推迟也不行：换源依赖点击处理与随后 loadstart 之间的同步时序，
   * 整体延后一个 tick 会导致首次播放不再换源（回归用例直接失败）。
   * 因此只拆出 DOM 写操作走这里，判断与状态记录仍然同步完成。
   */
  function deferDomWrite(task) {
    window.setTimeout(() => {
      try { task(); }
      catch (error) { debug('延迟 DOM 写入失败', error?.message || error); }
    }, 0);
  }

  function isHalloPage() {
    return location.pathname.includes(`/id${APPLE_SHOW_ID}`);
  }

  function isHalloContext() {
    return isHalloPage() || activeHalloContext;
  }

  /* 当前地址属于哪个节目；首页/搜索页等没有 /id 段时返回空串。 */
  function pageShowId() {
    return location.pathname.match(/\/id(\d+)/)?.[1] || '';
  }

  /*
   * activeHalloContext 是为了支持"在首页点哈喽怪谈的卡片直接播放"——那种场景
   * isHalloPage() 为 false，只能靠这个标记。但它只在点到别的节目的剧集时才会
   * 被清掉；如果用户是「跳转」到别的节目页（比如从哈喽怪谈进入奇了怪了），
   * 标记就一直是 true，于是那边点播放会被本脚本当成哈喽怪谈去换源，音频被替换
   * 或暂停，表现为"其他节目点了播不出来"。
   * 这里以地址里的节目 id 为准：只要当前页明确属于另一个节目，立刻释放上下文。
   */
  function releaseHalloContext(reason) {
    if (!activeHalloContext && !pendingTitle) return;
    /* 状态复位保持同步：后续的 loadstart/play 监听要立刻看到"已放手"。 */
    activeHalloContext = false;
    pendingTitle = '';
    desiredPlaying = false;
    pendingPlaybackGeneration = 0;
    /* 标题改写的标记必须一并清掉：syncPlayerTitle() 只要看到这个标记就会无条件
       改写该节点，不清的话播放器 LCD 会被按在旧集标题上，不跟随新节目刷新。
       但这是 DOM 写操作，必须推迟到事件派发之后（原因见点击监听器处的说明）。 */
    deferDomWrite(() => {
      for (const node of document.querySelectorAll('[data-testid="marquee-text-item"]')) {
        if (node.dataset) delete node.dataset.halloXimalayaTitle;
      }
    });
    debug('已离开哈喽怪谈，交还原生播放', reason);
  }

  /*
   * 沿 DOM 往上找这个按钮所属剧集链接里的节目 id。
   *
   * episodeContextFromButton() 依赖几个固定的 scope 选择器，首页/搜索页里其他
   * 播客的卡片结构与之不符时会返回 null。而"当前音频是喜马拉雅源"这条证据在
   * 哈喽怪谈正在播时恒为真，于是那种按钮会被误判成属于哈喽怪谈——这正是
   * 「在 Home 页播着哈喽怪谈时点别的播客没反应」的成因。
   * 这里只认剧集链接 a[href*="?i="] 上的 /id，与卡片结构无关；找不到链接
   * （例如迷你播放器的传输控件）才返回空串，交给调用方按别的证据判断。
   */
  function nearestEpisodeShowId(button) {
    let node = button;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const link = node.matches?.('a[href*="?i="]')
        ? node
        : node.querySelector?.('a[href*="?i="]');
      if (link?.href) {
        try {
          return new URL(link.href, location.href).pathname.match(/\/id(\d+)/)?.[1] || '';
        } catch {
          return '';
        }
      }
      node = node.parentElement;
    }
    return '';
  }

  /* 底部播放器里的传输控件（播放/暂停/快进等）。它们本来就没有剧集链接，
     只有这类按钮才允许用"当前音频是本脚本换的源"来判定归属。 */
  function isPlayerTransportButton(button) {
    return Boolean(button?.closest?.(
      '[class*="player-lcd"], [class*="playback-controls"], [class*="web-player"], '
      + '[data-testid*="player"], [class*="player-controls"]'
    ));
  }

  function releaseForeignShowContext() {
    const showId = pageShowId();
    if (!showId || showId === APPLE_SHOW_ID) return false;
    releaseHalloContext(showId);
    return true;
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

  /*
   * 播放/暂停的判定必须与界面语言无关。
   *
   * 实测：日文区按钮的 aria-label 是「再生、残り2時間12分」/「一時停止、…」，
   * 既不含 Play/Pause 也不含播放/暂停，且分隔符是顿号「、」；旧代码的
   * /^(?:Play|播放)(?:\b|[，,])/ 一条都匹配不上，于是整个脚本在日文区完全惰性
   * ——不换源、不迁移、连 data-hallo-ximalaya-managed 都不会写。繁体区的
   * 「暫停」同理（与简体「暂停」不是同一个字）。
   *
   * 这里两手准备：先按中英日词表匹配文案，匹配不上再退回原生图标判定
   * （按钮此刻显示"正在播放"图标，就说明这次点击的意图是暂停）。图标判定
   * 完全不依赖语言，是最终兜底。
   */
  const LABEL_SEPARATOR = '(?:\\b|[\\s，,、：:]|$)';
  const PLAY_LABEL_PATTERN = new RegExp(`^(?:play|播放|再生)${LABEL_SEPARATOR}`, 'i');
  const PAUSE_LABEL_PATTERN =
    new RegExp(`^(?:pause|暂停|暫停|一時停止|一时停止)${LABEL_SEPARATOR}`, 'i');

  /* 同一语言内的「播放 ↔ 暂停」词对，用于改写 aria-label 时保持语言一致。 */
  const LABEL_STATE_WORDS = [
    { play: 'Play', pause: 'Pause', match: /^(?:play|pause)/i },
    { play: '再生', pause: '一時停止', match: /^(?:再生|一時停止)/ },
    { play: '播放', pause: '暫停', match: /^暫停/ },
    { play: '播放', pause: '暂停', match: /^(?:播放|暂停|一时停止)/ }
  ];

  function rewriteLabelState(label, playing) {
    for (const words of LABEL_STATE_WORDS) {
      if (!words.match.test(label)) continue;
      return label.replace(words.match, playing ? words.pause : words.play);
    }
    return label;
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
      /* 采模板只看图标本身，不再要求 aria-label 是英文的 Play/Pause——
         日文/繁体区文案对不上会导致模板永远采不到，图标也就永远换不了。 */
      const showsPlaying = Boolean(icon.querySelector('[data-testid="playback-bars"].playing'));
      const showsPlay = Boolean(icon.querySelector('[data-testid="invertible-mask-svg"]'));
      if (showsPlaying) {
        pauseIconTemplate = icon.cloneNode(true);
      } else if (!playIconTemplate && showsPlay) {
        playIconTemplate = icon.cloneNode(true);
      }
      const titleKey = normalizeTitle(title);
      if (showsPlay && titleKey && !idleCardMetadata.has(titleKey)) {
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

  /*
   * 决定这两个指示器"显不显示"的，是 Apple 挂在祖先上的两个类，不是
   * playback-bars 自己的 .playing：
   *
   *   section.episode-details-container.is-playing
   *       → 驱动 .episode-details__playing-bars 的 transform: scaleX(0|1)，
   *         即标题日期左侧那圈持续声波的展开/收起；
   *   div.detailed-play-button-wrapper.progress-bar-visible
   *       → 驱动按钮里 .progress-bar 的 visibility 与宽度。
   *
   * 实测依据（真实页面逐层比对旧卡与正在播的卡）：两张卡片的 class 与内联样式
   * 完全相同，唯二差异就是这两个类；把它们搬到正在播的卡片后，该卡的
   * .episode-details__playing-bars 由 matrix(0,…)（scaleX(0)）变为 matrix(1,…)，
   * 声波 19/14、进度条 30 全部显示，旧卡则收起。
   *
   * 以前只切 .playing，类是加对了卡片，但容器被祖先按在 scaleX(0)/hidden 上，
   * 所以"标记全对、画面全错"——这正是切集后指示器不跟随的真正原因。
   *
   * is-playing 必须互斥（只有当前集能有）；progress-bar-visible 不从其他卡片
   * 摘除，因为原生行为是听过一部分的剧集会一直显示自己的进度。
   */
  function setCardPlayingBars(wrapper, playing) {
    const container = wrapper?.querySelector('.episode-details__playing-bars-inner');
    const bars = container?.querySelector?.('[data-testid="playback-bars"]')
      || wrapper?.querySelector('.episode-details__playing-bars-inner [data-testid="playback-bars"]');
    bars?.classList?.toggle('playing', playing);

    const section = wrapper?.querySelector?.('section.episode-details-container')
      || wrapper?.querySelector?.('.episode-details-container');
    section?.classList?.toggle?.('is-playing', playing);

    if (playing) {
      const buttonWrapper = wrapper?.querySelector?.('.detailed-play-button-wrapper');
      if (buttonWrapper?.classList?.add) {
        buttonWrapper.classList.add('progress-bar-visible');
        /* 记下"这个可见性是脚本打开的"，切集时才知道该还原哪些卡片，
           不会误伤 Apple 自己给其他剧集画的进度。 */
        if (buttonWrapper.dataset) buttonWrapper.dataset.halloXimalayaProgressVisible = '1';
      }
    }
  }

  /*
   * 切走当前集时撤掉脚本加的进度显示。
   *
   * 这里刻意用"结果导向"的不变量，而不是只信自己打过的标记：
   * 先移除自己注入的 progress，然后——只要这张卡片的 .progress-bar 里已经
   * 没有任何 progress 元素——就一定把 progress-bar-visible 摘掉。
   *
   * 原因：曾出现"首次切集后旧卡片进度条收起了，但播放按钮没缩回原宽度"
   * （▶ 与时长之间留一段空白）。空的 .progress-bar 只要还带着可见性类，就会
   * 继续占住按钮宽度（实测原生空闲按钮 85/88，带进度约 115）。用"没有 progress
   * 就不该保留可见性"这条不变量收口，无论那个类当初是脚本加的还是页面自带的，
   * 都不会留下撑宽的空容器；而真有原生 progress 的卡片（听过一部分的剧集）
   * 条件不成立，其进度照常保留，不受影响。
   */
  /*
   * 非当前集卡片的进度条维护。
   *
   * Svelte 重建卡片时会连带丢掉脚本注入的 <progress>，但挂在
   * .detailed-play-button-wrapper 上的 progress-bar-visible 会留下来——于是出现
   * "播放按钮被撑宽、里面却什么都没有"的空档（自动连播后尤其明显）。
   *
   * 原生行为是旧剧集继续显示自己的进度，所以这里优先按记录的位置把进度补回去；
   * 确实没有可显示的进度时，才摘掉可见性类，绝不留一个撑宽的空容器。
   */
  /*
   * 取容器里唯一的 progress，并顺手去重。
   *
   * 手动拖动跳转会密集触发 timeupdate/seeking，每次都要找"已有的进度条"。
   * 以前只按 progress[data-testid="progress-bar"] 查，Svelte 重建后容器换了实例、
   * 或克隆节点属性对不上时就会查空，于是又 append 一个——多次跳转后按钮里叠出
   * 好几段进度条（用户报的那张图）。
   * 这里改成按标签查全部：多于一个就只留一个（优先保留 Apple 原生那个，即没有
   * halloXimalayaProgress 标记的），其余删掉。
   */
  function findProgressIn(container) {
    if (!container) return null;
    if (!container.querySelectorAll) {
      return container.querySelector?.('progress[data-testid="progress-bar"]') || null;
    }
    const list = [...container.querySelectorAll('progress')];
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    const keep = list.find((node) => node.dataset?.halloXimalayaProgress !== '1') || list[0];
    for (const node of list) if (node !== keep) node.remove?.();
    return keep;
  }

  function restoreEpisodeProgress(item) {
    const container = progressContainerOf(item);
    if (!container) return;
    if (findProgressIn(container)) return;

    const stored = episodePositions.get(normalizeTitle(item.title));
    const time = Number(stored?.time) || 0;
    const total = Number(stored?.duration) || 0;

    if (time > 0 && total > 0 && progressTemplate?.cloneNode && container.append) {
      const progress = progressTemplate.cloneNode(true);
      container.append(progress);
      progress.max = total;
      progress.value = Math.max(0, Math.min(time, total));
      progress.setAttribute?.('max', String(total));
      progress.setAttribute?.('value', String(progress.value));
      if (progress.dataset) progress.dataset.halloXimalayaProgress = '1';
      const wrapper = playButtonWrapperOf(item);
      if (wrapper?.classList?.add) {
        wrapper.classList.add('progress-bar-visible');
        if (wrapper.dataset) wrapper.dataset.halloXimalayaProgressVisible = '1';
      }
      return;
    }

    clearManagedProgress(item);
  }

  function clearManagedProgress(item) {
    const buttonWrapper = playButtonWrapperOf(item);
    const progress = item.button?.querySelector?.('progress[data-testid="progress-bar"]');
    if (progress?.dataset?.halloXimalayaProgress === '1') progress.remove?.();

    const container = progressContainerOf(item);
    const stillHasProgress = Boolean(
      container?.querySelector?.('progress[data-testid="progress-bar"]')
    );
    if (!stillHasProgress && buttonWrapper?.classList?.remove) {
      buttonWrapper.classList.remove('progress-bar-visible');
      if (buttonWrapper.dataset) delete buttonWrapper.dataset.halloXimalayaProgressVisible;
    }
  }

  function progressContainerOf(item) {
    return item?.button?.querySelector('.progress-bar') || null;
  }

  function topBarsContainerOf(item) {
    return item?.wrapper?.querySelector('.episode-details__playing-bars-inner') || null;
  }

  /* 加可见性类和撤销可见性类必须查到同一个节点，否则会出现"加在 A、去 B 上找"
     而永远撤不掉的情况，因此统一走这一个入口。 */
  function playButtonWrapperOf(item) {
    return item?.button?.closest?.('.detailed-play-button-wrapper')
      || item?.wrapper?.querySelector?.('.detailed-play-button-wrapper')
      || null;
  }

  /*
   * 切集时不再交换 DOM 节点，只切换"谁是当前播放集"这个状态。
   *
   * 实测：每张剧集卡片都自带 .episode-details__playing-bars-inner 和
   * .progress-bar，未播放的卡片同样有。以前把这两个容器在卡片之间互换，带来
   * 两个与原生行为不符的后果：
   *   1) 声波容器被搬到别处，动画留在了错误的卡片上；
   *   2) 上一集自己的进度条被一起搬走，于是"切集后上一集的进度条不见了"——
   *      而原生 Podcasts 里，听过一部分的剧集会一直显示自己的进度。
   * 现在各卡片一律保留自己的原生容器，脚本只负责把活动标记落到目标卡片，
   * 由 setCardPlayingBars / syncActiveCardProgress 驱动对应卡片自己的节点。
   * Svelte 事后重建卡片也不再有"引用失效"问题：每次都从最新 DOM 重新查询。
   */
  function moveActiveContainersTo(target, entries) {
    activeProgressContainer = progressContainerOf(target);
    activeTopBarsContainer = topBarsContainerOf(target);

    for (const item of entries) {
      const progressContainer = progressContainerOf(item);
      const topBarsContainer = topBarsContainerOf(item);
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

  /* 迁移后的验收：全页任意时刻最多一个活动声波容器、一个活动进度容器，
     且都必须落在当前目标卡片上。校正循环用它判断"已经对了，可以停"。 */
  function activeCardStateSettled(title, playing) {
    const titleKey = normalizeTitle(title);
    if (!titleKey) return false;
    const entries = episodeCardEntries();
    const target = entries.find((item) => normalizeTitle(item.title) === titleKey);
    if (!target) return false;

    const targetProgress = progressContainerOf(target);
    const targetTopBars = topBarsContainerOf(target);
    let progressCount = 0;
    let topBarsCount = 0;
    let strayActive = false;
    let strayBars = false;

    for (const item of entries) {
      const progressContainer = progressContainerOf(item);
      const topBarsContainer = topBarsContainerOf(item);
      if (progressContainer?.dataset?.halloXimalayaActiveContainer === '1') {
        progressCount += 1;
        if (progressContainer !== targetProgress) strayActive = true;
      }
      if (topBarsContainer?.dataset?.halloXimalayaActiveContainer === '1') {
        topBarsCount += 1;
        if (topBarsContainer !== targetTopBars) strayActive = true;
      }
      if (item === target) continue;
      const bars = topBarsContainer?.querySelector?.('[data-testid="playback-bars"]');
      if (bars?.classList?.contains?.('playing')) strayBars = true;
    }

    if (strayActive || strayBars) return false;
    if (!playing) return true;
    return progressCount === 1 && topBarsCount === 1;
  }

  function restoreIdleMetadata(item, fallbackLabel = '') {
    const idle = idleCardMetadata.get(normalizeTitle(item.title));
    const label = idle?.label || rewriteLabelState(fallbackLabel, false);
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
    let progress = findProgressIn(container);
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
    /* 只有 .detailed-play-button-wrapper 带上 progress-bar-visible，
       按钮里的 .progress-bar 才会真的显示（否则 visibility:hidden、宽度 0）。 */
    const buttonWrapper = playButtonWrapperOf(item);
    if (buttonWrapper?.classList?.add) {
      buttonWrapper.classList.add('progress-bar-visible');
      if (buttonWrapper.dataset) buttonWrapper.dataset.halloXimalayaProgressVisible = '1';
    }
  }

  function syncCurrentCardProgress(title = playerTitle()) {
    const titleKey = normalizeTitle(title);
    const item = episodeCardEntries().find((entry) => normalizeTitle(entry.title) === titleKey);
    if (item) syncActiveCardProgress(item);
  }

  function reconcileNativeCardState(title, playing) {
    captureNativeButtonTemplates();
    const titleKey = normalizeTitle(title);
    const entries = episodeCardEntries();
    const target = entries.find((item) => normalizeTitle(item.title) === titleKey);
    if (!target) return false;

    /* 图标模板要等 Apple 自己渲染过一次暂停态才拿得到。以前模板没就位就整段
       return false，连带把两个容器的迁移也跳过了——这正是"首次点播时声波和
       进度条根本不迁移"的原因。现在容器归属先做，图标替换单独降级。 */
    const canSwapIcons = Boolean(playIconTemplate) && (!playing || Boolean(pauseIconTemplate));

    if (playing) moveActiveContainersTo(target, entries);

    // Restore non-target cards after moving the two exact native containers.
    for (const item of entries) {
      if (item === target) continue;
      setCardPlayingBars(item.wrapper, false);
      const label = item.button.getAttribute('aria-label') || '';
      const wasActive = PAUSE_LABEL_PATTERN.test(label)
        || buttonHasPlayingIcon(item.button)
        || item.button.dataset.halloXimalayaActive === '1';
      /* 原生行为（实测确认）：切到新剧集后，旧剧集的进度条不收起，而是继续显示
         离开时的进度；切回去时从该进度续播。若 Svelte 重建把注入的 progress
         丢了，这里按记录的位置补回去，避免留下被撑宽的空按钮。 */
      restoreEpisodeProgress(item);
      if (wasActive || item.button.dataset.halloXimalayaManaged === '1') {
        if (playIconTemplate && !buttonHasPlayIcon(item.button)) {
          replaceButtonIcon(item.button, playIconTemplate);
        }
        restoreIdleMetadata(item, label);
        item.button.dataset.halloXimalayaManaged = '1';
      }
      delete item.button.dataset.halloXimalayaActive;
    }

    setCardPlayingBars(target.wrapper, playing);
    if (canSwapIcons
      && (playing ? !buttonHasPlayingIcon(target.button) : !buttonHasPlayIcon(target.button))) {
      replaceButtonIcon(target.button, playing ? pauseIconTemplate : playIconTemplate);
    }
    const targetLabel = target.button.getAttribute('aria-label') || '';
    target.button.setAttribute('aria-label', rewriteLabelState(targetLabel, playing));
    target.button.dataset.halloXimalayaManaged = '1';
    if (playing) {
      target.button.dataset.halloXimalayaActive = '1';
      syncActiveCardProgress(target);
    } else {
      delete target.button.dataset.halloXimalayaActive;
    }
    return true;
  }

  /*
   * 以前是 [0, 48, 140, 320, 720] 五个写死的延迟各校正一次：Svelte 何时重渲染完
   * 全靠猜，晚于 720ms 的重建就再也没人纠正，状态便留在旧卡片上。
   *
   * 改成带截止时间的自校正循环：每轮先重排，再用 activeCardStateSettled() 实测
   * 是否已经"只有目标卡片持有活动容器且无残留声波"，正确即停，否则继续重试到
   * 窗口用尽。token 保证快速连点 A→B→C 时旧循环立刻失效，activeTitleKey 保证
   * 过期的目标不会把状态写回去。
   */
  function scheduleCardReconcile(title) {
    const titleKey = normalizeTitle(title);
    if (!titleKey) return;
    const token = ++cardReconcileToken;
    const deadline = Date.now() + CARD_RECONCILE_WINDOW;

    const step = () => {
      if (token !== cardReconcileToken || titleKey !== activeTitleKey) return;
      reconcileNativeCardState(title, desiredPlaying);
      if (activeCardStateSettled(title, desiredPlaying)) return;
      if (Date.now() >= deadline) return;
      window.setTimeout(step, CARD_RECONCILE_INTERVAL);
    };

    step();
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
      pendingPlaybackGeneration = activeGeneration;
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
      /* 切到另一集时不再一律从 0 开始：若这一集之前听过，回到它应当从当时的
         位置续播（原生行为）。同一集内换源则保持当前进度不动。 */
      const storedPosition = Number(episodePositions.get(resolved.titleKey)?.time) || 0;
      const resumeTime = switchedWhileOldEpisodeStillLoaded
        ? storedPosition
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

  /*
   * 播放器是否已经离开哈喽怪谈，去放别的内容了。
   *
   * play/loadstart 里有一句"当前源不是喜马拉雅就 ensureCurrentSource(true)"，
   * 本意是把 Apple 重置回原生源的同一集再拉回喜马拉雅。但它不区分两种情况：
   *   a) 同一集被 Apple 重置        —— 该救
   *   b) 用户点了别的播客，Apple 正在放新内容 —— 不该碰
   * 实测（用户在 Home 页播着哈喽怪谈时点别的播客）：点击后
   *   location.pathname = /us/home（没跳转，说明点击链路已正常）
   *   audio.currentSrc  = https://a.xmcdn.com/...（新播客的源被换回了哈喽怪谈）
   * 正是 b) 被当成 a) 处理，于是新播客永远播不出来。
   *
   * 判据：不在哈喽怪谈页、当前源不是我们换的、而播放器标题又已经不是我们上次
   * 应用的那一集——那就是用户换内容了，立刻放手，绝不救援。
   */
  function playerLeftHallo(audio) {
    if (isHalloPage()) return false;
    if (isXimalayaUrl(mediaUrl(audio))) return false;
    if (!appliedTitleKey) return false;
    const current = normalizeTitle(marqueeTitle());
    if (!current) return false;
    return current !== appliedTitleKey && current !== normalizeTitle(pendingTitle);
  }

  /*
   * 是否允许把"非喜马拉雅的源"拉回哈喽怪谈。
   *
   * 只有两种情形该救：
   *   1) 正在哈喽怪谈节目页——页面本身就限定了范围；
   *   2) 用户刚点了哈喽怪谈的剧集，pendingTitle 还在——首页卡片直接播放走这条。
   * 除此之外一律不碰。Home 页上别的播客刚被 Apple 设好源时，pendingTitle 已被
   * 点击处理器清空（点到别的节目就 releaseHalloContext()），因此不会被抢走。
   *
   * 这条判据刻意不看播放器标题：Apple 的 marquee 更新是异步的，loadstart 触发
   * 那一刻它往往还停在上一集，用标题比对会判定"没换内容"从而照样抢源——实测
   * 用户在 Home 页点别的播客后 currentSrc 仍是 xmcdn，就是卡在这一点上。
   */
  function mayRescueSource() {
    return isHalloPage() || Boolean(pendingTitle);
  }

  function attach(audio) {
    if (!(audio instanceof HTMLMediaElement)) return;
    activeAudio = audio;
    if (attachedAudio.has(audio)) return;
    attachedAudio.add(audio);

    audio.addEventListener('play', () => {
      if (!isHalloContext()) return;
      /* 播放器已经在放别的内容：放手，别把人家的源抢过来。 */
      if (playerLeftHallo(audio)) {
        releaseHalloContext('播放器已切到别的内容');
        return;
      }
      userPaused = false;
      desiredPlaying = true;
      if (isXimalayaUrl(mediaUrl(audio)) && appliedTitleKey === activeTitleKey) {
        pendingPlaybackGeneration = 0;
      }
      reconcileNativeCardState(playerTitle(), true);
      if (!isXimalayaUrl(mediaUrl(audio)) && mayRescueSource()) ensureCurrentSource(true);
    });

    audio.addEventListener('pause', () => {
      if (!isHalloContext() || applyingSource) return;
      window.setTimeout(() => {
        /* 用户主动暂停：由点击处理器置位，直接按暂停处理，不再依赖时间启发式。 */
        if (userPaused) {
          desiredPlaying = false;
          pendingPlaybackGeneration = 0;
          reconcileNativeCardState(playerTitle(), false);
          return;
        }
        /* 换源期间 Apple 会对旧音频触发内部 pause。此时用户的播放意图仍然成立，
           必须忽略，否则刚发起的切集会被自己取消。 */
        if (desiredPlaying && pendingPlaybackGeneration === activeGeneration) return;
        if (audio.paused && Date.now() - lastExplicitPlayAt > 400) {
          desiredPlaying = false;
          reconcileNativeCardState(playerTitle(), false);
        }
      }, 0);
    });

    audio.addEventListener('loadstart', () => {
      if (!isHalloContext() || applyingSource) return;
      /* 同上：Apple 正在为别的内容加载新源时不得介入。 */
      if (playerLeftHallo(audio)) {
        releaseHalloContext('播放器已切到别的内容');
        return;
      }
      const title = playerTitle();
      if (!title) return;
      setEpisode(title, false);
      if (!isXimalayaUrl(mediaUrl(audio)) && desiredPlaying && mayRescueSource()) {
        ensureCurrentSource(true);
      }
    });

    for (const eventName of ['loadedmetadata', 'durationchange', 'timeupdate']) {
      audio.addEventListener(eventName, () => {
        if (!isHalloContext() || !desiredPlaying) return;
        /* 记下当前这一集听到哪儿，切走再切回来时据此续播。 */
        const position = Number(audio.currentTime);
        const total = Number(audio.duration);
        if (appliedTitleKey && Number.isFinite(position) && position > 0) {
          episodePositions.set(appliedTitleKey, {
            time: position,
            duration: Number.isFinite(total) && total > 0 ? total : 0
          });
          saveEpisodePositions();
        }
        syncCurrentCardProgress();
      });
    }

    for (const eventName of ['waiting', 'stalled']) {
      audio.addEventListener(eventName, () => {
        if (isHalloContext() && desiredPlaying
          && !isXimalayaUrl(mediaUrl(audio)) && mayRescueSource()) {
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
    /* SPA 跳转到别的节目页时没有点击事件可依附，这里兜底释放上下文。 */
    if (releaseForeignShowContext()) return;
    if (!isHalloContext()) return;
    captureNativeButtonTemplates();

    /*
     * pendingTitle 只是"点击了但 Apple 的播放器标题还没更新"这段空窗期的临时凭据。
     * 以前它一旦设上就永不清除，而 playerTitle() 又优先返回它——于是一集播完
     * 自动连播到下一集时（全程没有点击），脚本仍把上一集当成当前集，两个指示器
     * 自然不会跟着走。
     * 这里在播放器标题追上 pendingTitle 之后就把它释放，之后一律以 marquee 为准，
     * 自动连播才能被跟随。marquee 尚未追上时保持不变，避免被旧标题切回上一集。
     */
    if (pendingTitle) {
      const marquee = marqueeTitle();
      if (marquee && normalizeTitle(marquee) === normalizeTitle(pendingTitle)) {
        pendingTitle = '';
      }
    }

    if (pendingTitle) {
      syncPlayerTitle(pendingTitle);
      reconcileNativeCardState(pendingTitle, desiredPlaying);
    }
    const title = playerTitle();
    if (!title) return;
    const titleChanged = normalizeTitle(title) !== activeTitleKey;
    const generation = setEpisode(title, false);
    if (titleChanged) {
      prewarm(title);
      /* 自动连播没有点击可依附，这里补一次自校正循环，让两个指示器跟着新集走。 */
      if (desiredPlaying) scheduleCardReconcile(title);
    }

    /* scan() 由全局 MutationObserver 驱动（另有 1s 兜底），因此 Svelte 事后
       重建卡片、把活动节点放回旧剧集时，这里会实测出状态不对并重新校正归属。
       只在确实不对时才动手，正常情况下不产生任何写操作。 */
    if (desiredPlaying && !activeCardStateSettled(title, true)) {
      reconcileNativeCardState(title, true);
    }

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
      /* 当前页属于别的节目时立刻放手，避免把它的播放当成哈喽怪谈去换源。 */
      if (releaseForeignShowContext()) return;
      const episodeContext = episodeContextFromButton(button);
      if (episodeContext) {
        activeHalloContext = episodeContext.showId === APPLE_SHOW_ID;
        if (!activeHalloContext) {
          releaseHalloContext(episodeContext.showId);
          return;
        }
      } else if (nearestEpisodeShowId(button)
        && nearestEpisodeShowId(button) !== APPLE_SHOW_ID) {
        /* 按钮所属的剧集链接明确指向别的节目：放手，交还原生播放。 */
        releaseHalloContext(nearestEpisodeShowId(button));
        return;
      } else if (!nearestEpisodeShowId(button) && !isHalloPage()
        && !isPlayerTransportButton(button)) {
        /*
         * 既解析不出剧集归属、又不在哈喽怪谈节目页，而且这不是播放器的传输控件
         * ——那它就是某张卡片的播放键，只是版式不认识。此时一律放手。
         *
         * 实测依据：Home 页存在一类卡片，其播放键向上 8 层都没有
         * a[href*="?i="]，episodeContextFromButton() 与 nearestEpisodeShowId()
         * 双双落空。以前这里会退到"当前音频是喜马拉雅源"这条证据，而哈喽怪谈
         * 正在播时它恒为真，于是照样放行、把别的播客当成哈喽怪谈处理——这正是
         * 「Home 页播着哈喽怪谈时点别的节目没反应」的最后一块拼图。
         * 那条证据只对传输控件成立，卡片播放键一概不适用。
         */
        releaseHalloContext('卡片播放键但归属不明');
        return;
      } else if (!isHalloPage() && !isXimalayaUrl(mediaUrl(activeAudio))) {
        /*
         * 这次点击的按钮无法解析出剧集上下文（首页/搜索页的卡片结构不同、
         * 迷你播放器的控件等），同时既不在哈喽怪谈节目页、当前音频也不是我们
         * 换过的喜马拉雅源——也就是没有任何证据表明这次点击属于哈喽怪谈。
         *
         * 以前这里的条件是 !isHalloContext()：只要 activeHalloContext 还残留着
         * true 就会继续往下走，于是在别的播客点播放会被当成哈喽怪谈处理——
         * pendingTitle 还停在上一集，48ms 后 ensureCurrentSource() 把 audio.src
         * 换回旧集并 pause()，表现就是「按钮根本没反应」。地址里没有 /id 段的
         * 首页/搜索页尤其容易中招，releaseForeignShowContext() 也兜不住。
         *
         * 改成必须正面确认：确认不了就放手，并清掉残留上下文。
         */
        releaseHalloContext('无法确认点击归属');
        return;
      }
      /* 文案匹配不上（未知语言）时退回图标判定：按钮此刻显示"正在播放"图标，
         就说明这次点击的意图是暂停；显示三角形播放图标则是播放。 */
      const wantsPause = PAUSE_LABEL_PATTERN.test(label)
        || (!PLAY_LABEL_PATTERN.test(label) && buttonHasPlayingIcon(button));
      const wantsPlay = !wantsPause && (PLAY_LABEL_PATTERN.test(label)
        || buttonHasPlayIcon(button));

      if (wantsPause) {
        userPaused = true;
        desiredPlaying = false;
        pendingPlaybackGeneration = 0;
        /* 暂停音频本身保持同步，用户要的是立刻停；卡片状态是 DOM 写，推迟。 */
        if (activeAudio && !activeAudio.paused) activeAudio.pause();
        const pausedTitle = playerTitle();
        deferDomWrite(() => reconcileNativeCardState(pausedTitle, false));
        return;
      }

      if (wantsPlay) {
        userPaused = false;
        let requestedGeneration = activeGeneration;
        const clickedTitle = episodeContext?.title
          || button.closest('[data-testid="episode-wrapper"]')
            ?.querySelector('[data-testid="episode-lockup-title"]')?.textContent?.trim();
        if (clickedTitle) {
          pendingTitle = clickedTitle;
          const generation = setEpisode(clickedTitle, true);
          requestedGeneration = generation;
          prewarm(clickedTitle);
          /* 自校正循环第一轮会立刻改 DOM，同样推迟到派发之后。 */
          deferDomWrite(() => scheduleCardReconcile(clickedTitle));
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
    loadEpisodePositions();
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
