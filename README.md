# Stylus-Cascadea-CSS

一组自用的 [Stylus](https://add0n.com/stylus.html) 用户样式表，为常用网站加上克制的 Apple 风格卡片、悬浮动效与统一字体。

设计取向是"克制"：不重做页面布局，只在原生结构上补圆角、磨砂玻璃、柔和阴影和短促的悬浮过渡，尽量沿用各站点自己的配色与间距。

## 样式表一览

| 样式表 | 版本 | 生效范围 | 作用 |
| --- | --- | --- | --- |
| [`global.user.css`](global.user.css) | 1.1.1 | 所有网站 | 统一字体栈为 Anthropic Sans + Noto Sans，代码元素保留等宽字体 |
| [`bilibili-apple.user.css`](bilibili-apple.user.css) | 8.13.0 | `bilibili.com` 主站 / 动态 / 搜索 / 空间 / 消息 | 首页网格、播放页推荐与播放器圆角、动态视频、动态页 Apple 背景、个人空间卡片及全站紫色强调色 |
| [`youtube-apple.user.css`](youtube-apple.user.css) | 2.20.39 | `youtube.com` | 顶栏、分类栏、左侧导航和视频卡片的悬浮动效 |
| [`x-apple.user.css`](x-apple.user.css) | 1.7.12 | `x.com`、`twitter.com` | 右栏模块、推文信息流和左侧导航的卡片与悬浮动画 |
| [`google-apple.user.css`](google-apple.user.css) | 1.5.7 | `google.com` 及 8 个地区域名 | 搜索结果与顶部控件的动效和磨砂玻璃 |
| [`xiaohongshu-apple.user.css`](xiaohongshu-apple.user.css) | 1.0.0 | `xiaohongshu.com` | 左侧导航按钮和图文卡片的悬浮动效，视觉语言对齐 X 的方案 |
| [`instagram-apple.user.css`](instagram-apple.user.css) | 1.0.0 | `instagram.com` | 左侧导航、快拍 Dock 单点放大、信息流卡片与 Messages 浮钮；材质与位移分层渲染 |
| [`apple-podcasts-cards-effect.user.css`](apple-podcasts-cards-effect.user.css) | 3.9.1 | `podcasts.apple.com` | 新版 Web 端节目卡片、左侧导航和播放器按钮的悬浮动效 |

`global.user.css` 与各站点样式表相互独立，可以只装其中一部分。

## 安装

1. 安装 Stylus 扩展（[Chrome](https://chromewebstore.google.com/detail/stylus/clngdbkpkpeebahjckkjfobafhncgmne) / [Firefox](https://addons.mozilla.org/firefox/addon/styl-us/) / [Edge](https://microsoftedge.microsoft.com/addons/detail/stylus/fjnbnpbmkenffdnngjfgmeleoegfcffe)）。
2. 在上表中点开想要的样式表，点击 GitHub 页面上的 **Raw**。
3. Stylus 会识别 `.user.css` 并弹出安装页，点击 **Install style**。

每个样式表都带 `@updateURL`，指向本仓库 `main` 分支的 raw 地址，因此 Stylus 的"检查更新"会直接拉取这里的最新版本。

## 字体说明

`global.user.css` 使用的字体栈是：

```
Anthropic Sans Text → Anthropic Sans → Noto Sans SC → Noto Sans CJK SC
→ Noto Sans JP → Noto Sans CJK JP → Segoe UI Emoji → sans-serif
```

这些字体需要装在本机才会生效，否则会逐级回退到系统 sans-serif。`code`、`pre`、`kbd`、`samp` 等元素以及图标字体类名（Font Awesome、Material Icons、Octicons 等）已被排除，不受字体覆盖影响。

## 开发约定

- 文件名用 `<站点>-apple.user.css`，`@namespace` 全局唯一。
- 改动样式后同步递增 `@version`，否则 Stylus 客户端不会认为有更新。
- 选择器尽量基于实测的页面结构（浏览器开发者工具逐层核实），并在注释里记下依据 —— 站点改版后这些注释是排查的起点。
- 颜色与动效参数集中定义在 `:root` 的 CSS 变量里，不要在规则中散落魔数。

## 分支

- `main` —— 发布分支，`@updateURL` 指向这里。
- `Font` —— 字体相关实验分支；早期的独立字体样式表（`youtube-font`、`x-font` 等）已在 `main` 上合并进 `global.user.css`。
