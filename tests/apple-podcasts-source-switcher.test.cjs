const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(
  path.join(__dirname, '..', 'apple-podcasts-source-switcher.user.js'),
  'utf8'
);

const XM_A = 'https://a.xmcdn.com/a.m4a';
const XM_B = 'https://a.xmcdn.com/b.m4a';

function createHarness({ hallo = true, requestDelay = 0 } = {}) {
  const listeners = new Map();
  const requests = [];
  let currentPlayerTitle = '节目甲';
  let decryptResult = XM_A;
  let intervalCallback = null;
  const marqueeNodes = [
    { textContent: '节目甲', dataset: {}, closest: () => null },
    { textContent: '节目甲', dataset: {}, closest: () => null },
    { textContent: '今天', dataset: {}, closest: () => null },
    { textContent: '今天', dataset: {}, closest: () => null }
  ];

  class Element {
    closest() { return null; }
  }

  class FakeIcon extends Element {
    constructor(kind) {
      super();
      this.kind = kind;
      this.owner = null;
    }
    cloneNode() { return new FakeIcon(this.kind); }
    querySelector(selector) {
      if (selector === '[data-testid="playback-bars"].playing' && this.kind === 'native-pause') return {};
      if (selector === '[data-testid="invertible-mask-svg"]' && this.kind === 'play') return {};
      return null;
    }
    replaceWith(next) {
      if (!this.owner) return;
      this.owner.icon = next;
      next.owner = this.owner;
    }
  }

  class FakeClassList {
    constructor() { this.values = new Set(); }
    add(value) { this.values.add(value); }
    toggle(value, force) {
      if (force) this.values.add(value);
      else this.values.delete(value);
    }
    contains(value) { return this.values.has(value); }
  }

  class FakeBars extends Element {
    constructor() {
      super();
      this.classList = new FakeClassList();
    }
    cloneNode() {
      const clone = new FakeBars();
      for (const value of this.classList.values) clone.classList.add(value);
      return clone;
    }
    querySelectorAll(selector) {
      return selector === '[data-testid="playback-bars"]' ? [this] : [];
    }
  }

  class FakeProgress extends Element {
    constructor(value = 0, max = 100) {
      super();
      this.value = value;
      this.max = max;
      this.dataset = {};
    }
    cloneNode() { return new FakeProgress(this.value, this.max); }
    remove() {
      if (this.owner) this.owner.progress = null;
    }
    setAttribute(name, value) {
      if (name === 'value') this.value = Number(value);
      if (name === 'max') this.max = Number(value);
    }
  }

  class FakeProgressContainer extends Element {
    constructor(progress = null) {
      super();
      this.progress = progress;
      if (this.progress) this.progress.owner = this;
      this.owner = null;
    }
    cloneNode() { return new FakeProgressContainer(this.progress?.cloneNode() || null); }
    querySelector(selector) {
      return selector === 'progress[data-testid="progress-bar"]' ? this.progress : null;
    }
    append(progress) {
      this.progress = progress;
      progress.owner = this;
    }
    replaceWith(next) {
      if (!this.owner) return;
      this.owner.progressContainer = next;
      next.owner = this.owner;
    }
  }

  class FakeButtonText extends Element {
    constructor(text) {
      super();
      this.textContent = text;
      this.owner = null;
    }
    cloneNode() { return new FakeButtonText(this.textContent); }
    replaceWith(next) {
      if (!this.owner) return;
      this.owner.text = next;
      next.owner = this.owner;
    }
  }

  class FakeEpisodeButton extends Element {
    constructor(title, remaining) {
      super();
      this.title = title;
      this.remaining = remaining;
      this.label = `Play, ${remaining}`;
      this.dataset = {};
      this.icon = new FakeIcon('play');
      this.icon.owner = this;
      this.progressContainer = new FakeProgressContainer();
      this.progressContainer.owner = this;
      this.text = new FakeButtonText(remaining);
      this.text.owner = this;
      this.wrapper = null;
    }
    getAttribute(name) {
      if (name === 'aria-label') return this.label;
      return '';
    }
    setAttribute(name, value) {
      if (name === 'aria-label') this.label = value;
    }
    querySelector(selector) {
      if (selector === '[data-testid="button-icon"]') return this.icon;
      if (selector === '[data-testid="button-icon"] [data-testid="playback-bars"].playing') {
        return this.icon.querySelector('[data-testid="playback-bars"].playing');
      }
      if (selector === '[data-testid="button-icon"] [data-testid="invertible-mask-svg"]') {
        return this.icon.querySelector('[data-testid="invertible-mask-svg"]');
      }
      if (selector === 'progress[data-testid="progress-bar"]') return this.progressContainer.progress;
      if (selector === '.progress-bar') return this.progressContainer;
      if (selector === '[data-testid="hero__play-button-text"]') return this.text;
      return null;
    }
    closest(selector) {
      if (selector === 'button') return this;
      if (selector === '[data-testid="episode-wrapper"]') return this.wrapper;
      return null;
    }
  }

  const episodeCards = [
    { title: '节目甲', button: new FakeEpisodeButton('节目甲', '10 minutes remaining') },
    { title: '节目乙', button: new FakeEpisodeButton('节目乙', '20 minutes remaining') }
  ];
  for (const card of episodeCards) {
    card.bars = new FakeBars();
    card.wrapper = {
      querySelector(selector) {
        if (selector === '[data-testid="episode-lockup-title"]') return { textContent: card.title };
        if (selector === 'button[data-testid="hero__play-button"]') return card.button;
        if (selector === '.episode-details__playing-bars-inner') return card.bars;
        if (selector === '.episode-details__playing-bars-inner [data-testid="playback-bars"]') return card.bars;
        return null;
      },
      querySelectorAll(selector) {
        return selector === '[data-testid="playback-bars"]' ? [card.bars] : [];
      }
    };
    card.button.wrapper = card.wrapper;
  }

  class HTMLMediaElement extends Element {}
  HTMLMediaElement.HAVE_METADATA = 1;
  HTMLMediaElement.HAVE_CURRENT_DATA = 2;

  class FakeAudio extends HTMLMediaElement {
    constructor() {
      super();
      this.src = 'https://apple.example/a.mp3';
      this.currentSrc = this.src;
      this.currentTime = 0;
      this.duration = 100;
      this.readyState = 0;
      this.paused = true;
      this.events = new Map();
      this.playCount = 0;
    }

    addEventListener(name, handler, options = {}) {
      const wrapped = options.once
        ? (...args) => { this.removeEventListener(name, wrapped); handler(...args); }
        : handler;
      const handlers = this.events.get(name) || [];
      handlers.push(wrapped);
      this.events.set(name, handlers);
    }

    removeEventListener(name, handler) {
      this.events.set(name, (this.events.get(name) || []).filter((item) => item !== handler));
    }

    emit(name) {
      for (const handler of [...(this.events.get(name) || [])]) handler({ type: name });
    }

    pause() { this.paused = true; }

    load() {
      this.currentSrc = this.src;
      this.emit('loadstart');
      queueMicrotask(() => {
        this.readyState = HTMLMediaElement.HAVE_METADATA;
        this.emit('loadedmetadata');
      });
    }

    async play() {
      this.paused = false;
      this.playCount += 1;
      this.emit('play');
    }
  }

  const audio = new FakeAudio();
  const storage = new Map();
  const document = {
    readyState: 'complete',
    title: hallo ? '哈喽怪谈 - Podcast - Apple Podcasts' : '其他播客 - Apple Podcasts',
    documentElement: {},
    addEventListener(name, handler) { listeners.set(name, handler); },
    querySelector(selector) {
      if (selector === '#apple-music-player, audio') return audio;
      if (selector === '[data-testid="marquee-text-item"]') {
        return marqueeNodes[0];
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-testid="marquee-text-item"]') return marqueeNodes;
      if (selector === '[data-testid="episode-wrapper"]') return episodeCards.map((card) => card.wrapper);
      return [];
    }
  };

  const context = {
    console,
    document,
    Element,
    HTMLMediaElement,
    location: {
      href: hallo
        ? 'https://podcasts.apple.com/us/podcast/hallo/id512426799'
        : 'https://podcasts.apple.com/us/podcast/other/id999999999',
      pathname: hallo
        ? '/us/podcast/hallo/id512426799'
        : '/us/podcast/other/id999999999'
    },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); }
    },
    MutationObserver: class { observe() {} },
    requestAnimationFrame(callback) { callback(); },
    setInterval(callback) { intervalCallback = callback; return 1; },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
    CryptoJS: {
      AES: { decrypt: () => ({ toString: () => decryptResult }) },
      enc: {
        Base64url: { parse: (value) => value },
        Hex: { parse: (value) => value },
        Utf8: 'utf8'
      },
      mode: { ECB: 'ecb' },
      pad: { Pkcs7: 'pkcs7' }
    },
    GM_xmlhttpRequest(options) {
      requests.push(options.url);
      const respond = (payload) => {
        if (requestDelay > 0) setTimeout(() => options.onload(payload), requestDelay);
        else queueMicrotask(() => options.onload(payload));
      };
      if (options.url.includes('queryAlbumPage')) {
        respond({
          status: 200,
          responseText: JSON.stringify({
            data: {
              typeSpecData: {
                freeOrSingleAlbumData: {
                  albumPageTrackRecords: {
                    trackDetailInfos: [
                      { trackInfo: { id: 101, title: '节目甲' } },
                      { trackInfo: { id: 102, title: '节目乙' } }
                    ]
                  }
                }
              }
            }
          })
        });
        return;
      }
      if (options.url.includes('trackId=101')) decryptResult = XM_A;
      if (options.url.includes('trackId=102')) decryptResult = XM_B;
      respond({
        status: 200,
        responseText: JSON.stringify({
          trackInfo: { playUrlList: [{ type: 'M4A_64', url: 'ciphertext' }] }
        })
      });
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'apple-podcasts-source-switcher.user.js' });

  function clickPlay(title, { updateMarquee = true, nativeVisualSwitch = true } = {}) {
    if (updateMarquee) {
      currentPlayerTitle = title;
      marqueeNodes[0].textContent = title;
      marqueeNodes[1].textContent = title;
    }
    const card = episodeCards.find((item) => item.title === title);
    listeners.get('click')?.({
      target: card.button,
      preventDefault() {},
      stopImmediatePropagation() {}
    });
    if (nativeVisualSwitch) {
      for (const item of episodeCards) {
        item.button.label = `${item === card ? 'Pause' : 'Play'}, ${item.button.remaining}`;
        item.button.icon = new FakeIcon(item === card ? 'native-pause' : 'play');
        item.button.icon.owner = item.button;
        item.bars.classList.toggle('playing', item === card);
        if (item === card && !item.button.progressContainer.progress) {
          const progress = new FakeProgress(1, 100);
          progress.owner = item.button.progressContainer;
          item.button.progressContainer.progress = progress;
        }
      }
    }
  }

  function clickPause() {
    const activeCard = episodeCards.find((item) => /^Pause\b/.test(item.button.label));
    const button = activeCard?.button;
    listeners.get('click')?.({
      target: button,
      preventDefault() {},
      stopImmediatePropagation() {}
    });
    if (activeCard) {
      activeCard.button.label = `Play, ${activeCard.button.remaining}`;
      activeCard.button.icon = new FakeIcon('play');
      activeCard.button.icon.owner = activeCard.button;
      activeCard.bars.classList.toggle('playing', false);
    }
  }

  function loadAppleSource(url, time = 0) {
    audio.src = url;
    audio.currentSrc = url;
    audio.currentTime = time;
    audio.readyState = 0;
    audio.emit('loadstart');
  }

  return {
    audio,
    requests,
    clickPlay,
    clickPause,
    loadAppleSource,
    runScan() { intervalCallback?.(); },
    cardStates() {
      return episodeCards.map((card) => ({
        label: card.button.label,
        icon: card.button.icon.kind,
        indicatorPlaying: card.bars.classList.contains('playing'),
        text: card.button.text.textContent
      }));
    },
    progressStates() {
      return episodeCards.map((card) => {
        const progress = card.button.progressContainer.progress;
        return progress ? { value: progress.value, max: progress.max } : null;
      });
    },
    playerTitles() { return marqueeNodes.map((node) => node.textContent); },
    setTitle(title) {
      currentPlayerTitle = title;
      marqueeNodes[0].textContent = title;
      marqueeNodes[1].textContent = title;
    }
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 90));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

(async () => {
  const hallo = createHarness();
  hallo.clickPlay('节目甲');
  hallo.loadAppleSource('https://apple.example/a.mp3', 18);
  await settle();
  assert.equal(hallo.audio.currentSrc, XM_A, '首次播放应透明替换为喜马拉雅地址');
  assert.equal(hallo.audio.currentTime, 18, '同一集替换播放源时应保留当前进度');
  assert.ok(hallo.audio.playCount >= 1, '替换后应继续使用原生 audio 播放');

  hallo.clickPause();
  await settle();
  assert.equal(hallo.audio.paused, true, '点击暂停后应直接暂停当前喜马拉雅音频');

  hallo.clickPlay('节目甲');
  await settle();
  assert.equal(hallo.audio.paused, false, '同一集再次点击播放后应恢复播放');

  hallo.clickPlay('节目乙');
  await settle();
  assert.equal(hallo.audio.currentSrc, XM_B, '切换节目后应使用新一集的喜马拉雅地址');
  assert.equal(hallo.audio.currentTime, 0, '切换节目不得继承上一集播放进度');
  assert.equal(hallo.requests.filter((url) => url.includes('queryAlbumPage')).length, 1,
    '节目目录在同一页面中只应请求一次');

  const delayed = createHarness({ requestDelay: 10 });
  delayed.clickPlay('节目甲');
  delayed.clickPause();
  await settle();
  assert.equal(delayed.audio.paused, true, '异步解析完成后不得推翻用户的暂停操作');
  delayed.clickPlay('节目甲');
  await settle();
  assert.equal(delayed.audio.currentSrc, XM_A, '暂停后再次播放时应完成喜马拉雅换源');

  const rapid = createHarness({ requestDelay: 10 });
  rapid.clickPlay('节目甲');
  rapid.clickPlay('节目乙');
  await settle();
  assert.equal(rapid.audio.currentSrc, XM_B, '快速连续切集时只允许最新一集生效');

  const staleMarquee = createHarness();
  staleMarquee.clickPlay('节目甲');
  await settle();
  staleMarquee.clickPlay('节目乙', { updateMarquee: false });
  await settle();
  staleMarquee.runScan();
  await settle();
  assert.equal(staleMarquee.audio.currentSrc, XM_B,
    'Apple 播放器标题尚未更新时，不得被旧标题切回上一集');
  assert.deepEqual(staleMarquee.playerTitles(), ['节目乙', '节目乙', '今天', '今天'],
    '换源后应同步两份播放器标题，同时不得覆盖日期');

  const staleCardState = createHarness();
  staleCardState.clickPlay('节目甲');
  await settle();
  staleCardState.clickPlay('节目乙', { nativeVisualSwitch: false });
  await settle();
  assert.deepEqual(staleCardState.cardStates(), [
    {
      label: 'Play, 10 minutes remaining', icon: 'play', indicatorPlaying: false,
      text: '10 minutes remaining'
    },
    {
      label: 'Pause, 20 minutes remaining', icon: 'native-pause', indicatorPlaying: true,
      text: '20 minutes remaining'
    }
  ], 'Apple 换源后未迁移卡片状态时，脚本应把两处原生持续声波动画迁移到当前剧集');
  assert.deepEqual(staleCardState.progressStates(), [null, { value: 0, max: 100 }],
    '切换剧集时应清除旧卡片的错误活动进度，并把当前音频进度迁移到新卡片');

  const other = createHarness({ hallo: false });
  other.clickPlay('节目甲');
  other.loadAppleSource('https://apple.example/other.mp3', 7);
  await settle();
  assert.equal(other.audio.currentSrc, 'https://apple.example/other.mp3',
    '非《哈喽怪谈》节目必须保持 Apple 原播放源');
  assert.equal(other.requests.length, 0, '非《哈喽怪谈》不得请求喜马拉雅接口');

  console.log('apple-podcasts-source-switcher: all tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
