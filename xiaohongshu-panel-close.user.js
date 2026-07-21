// ==UserScript==
// @name         小红书 搜索建议面板收起动画
// @namespace    rednote-panel-close-animation
// @version      1.2.0
// @description  为小红书搜索框的建议下拉面板补一个收起动画：面板被搜索框吸回去（站点原生是直接从 DOM 移除，纯 CSS 做不到）
// @updateURL    https://raw.githubusercontent.com/GavinLeee/Stylus-Cascadea-CSS/main/xiaohongshu-panel-close.user.js
// @downloadURL  https://raw.githubusercontent.com/GavinLeee/Stylus-Cascadea-CSS/main/xiaohongshu-panel-close.user.js
// @match        https://www.xiaohongshu.com/*
// @match        https://xiaohongshu.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 为什么需要这个脚本：
 *
 * 小红书搜索框展开时，建议面板 .ai-dropdown-panel 有原生的 fadeIn 入场动画
 * （0.2s ease-in-out），但收起时没有任何出场动画——面板是被直接从 DOM 里
 * 移除的，不是隐藏。用 MutationObserver 实测过一次收起：
 *
 *     class变化: textarea-container textarea-container-small
 *     class变化: wendian-wrapper wendian-wrapper--focused search-input
 *     面板被移除          <- 约 t=56ms
 *     class变化: wendian-wrapper search-input
 *
 * 节点一旦离开 DOM，CSS 的 transition / animation 就没有附着对象；
 * @starting-style + transition-behavior: allow-discrete 那套也只覆盖 display
 * 切换，不覆盖节点移除。所以这件事纯 CSS 做不了，只能靠脚本。
 *
 * 做法：监听移除，把刚被移除的那个节点原样塞回父节点，加一个 closing 类播完
 * 出场动画再自己删掉。出场做成面板被搜索框"吸回去"的收拢效果（见下方
 * keyframes 注释），和原生展开时从框里推出来的观感对称。这个节点此时已经脱离
 * 了站点框架（Vue 认为它没了、不会再管它），塞回去只是当一张"遗照"用，不参与
 * 任何交互（pointer-events: none），所以不会干扰重新展开。实测开→关→重开：
 * 面板总数始终是 1，无残留、观察器也不会重复触发。
 *
 * 外观（玻璃材质、圆角、层级）都在 xiaohongshu-apple.user.css 里；这里只补
 * 收起动画，两者互相独立，单独装任意一个都能正常工作。
 */

(() => {
  'use strict';

  const PANEL_CLASS = 'ai-dropdown-panel';
  const CLOSING_CLASS = 'rn-panel-closing';
  const GHOST_FLAG = 'rnPanelGhost';
  const DURATION = 200;
  /* 动画播完靠 animationend 收尾；这个兜底定时器防止标签页在后台被节流、
     animationend 迟迟不来时留下一张永久的遗照。 */
  const CLEANUP_FALLBACK = DURATION + 200;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function injectStyle() {
    if (document.getElementById('rn-panel-close-style')) return;
    const style = document.createElement('style');
    style.id = 'rn-panel-close-style';
    style.textContent = `
      /* 收起 = 面板被搜索框"吸回去"。
         位移和裁切同步进行：面板整体上移自身高度（translateY -100%），
         同时从顶部裁掉等量（clip-path inset 顶部 0→100%）。两者抵消后，
         可见区的上边缘恒定停在搜索框下沿，下边缘一路收上去，直到归零。

         实测（搜索框下沿 y=86）：
             t=0    面板顶 86    可见上沿 86    面板底 395
             t=76   面板顶 16    可见上沿 87    面板底 323
             t=159  面板顶 -179  可见上沿 87    面板底 127
         面板顶一路上移，可见上沿却焊在 86~87 不动——看起来就是被框吞回去。

         没有用 scaleY 收拢：那样内容会被纵向压扁（实测可见文字挤成一团）。
         这套写法内容只平移不形变。
         也没有加 opacity 淡出：淡出会盖过位移感，正是上一版被指出的问题。
         时长与缓动仍照抄原生入场动画 fadeIn-6869a472 的 0.2s ease-in-out。

         右/下留 -100px：面板原生就带 clip-path: inset(0px -100px -100px)，
         负值是给自己的投影留出绘制空间。这里照抄，否则动画一起手就把投影
         裁掉，面板会先"啪"地掉一圈阴影再开始收。 */
      @keyframes rn-panel-close-out {
        from { transform: translateY(0);     clip-path: inset(0    -100px -100px); }
        to   { transform: translateY(-100%); clip-path: inset(100% -100px -100px); }
      }
      .${CLOSING_CLASS} {
        pointer-events: none !important;
        animation: rn-panel-close-out ${DURATION}ms ease-in-out forwards !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function playClosing(panel, parent) {
    panel.dataset[GHOST_FLAG] = '1';
    panel.classList.add(CLOSING_CLASS);
    parent.appendChild(panel);

    /* 标记不用清：实测站点每次展开都是新建节点（给旧节点打自定义属性、
       收起再展开，拿到的是另一个对象、属性不在），旧节点被丢弃后自然回收，
       标记留在上面无人再读。 */
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      panel.remove();
    };
    panel.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, CLEANUP_FALLBACK);
  }

  const observer = new MutationObserver((records) => {
    if (reduceMotion.matches) return;

    for (const record of records) {
      if (record.type !== 'childList' || !record.removedNodes.length) continue;

      for (const node of record.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (!node.classList || !node.classList.contains(PANEL_CLASS)) continue;
        /* 已经是遗照的不再处理，否则自己删自己会无限套娃。 */
        if (node.dataset[GHOST_FLAG]) continue;

        const parent = record.target;
        /* 父节点自己也被摘掉时（整块搜索组件重建、SPA 换页）就别塞了，
           否则会把节点挂到一棵已经脱离文档的子树上，动画不会播、也删不掉。 */
        if (!parent || !parent.isConnected) continue;

        injectStyle();
        playClosing(node, parent);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
