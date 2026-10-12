/**
 * 样式注入（照抄 DSH 官方 UI 包的 idiom）。
 *
 * 官方每个 UI 包都把 CSS 字符串内联在 lib/client.js 顶部，并以
 * `<style data-plugin-css="<包名>/<文件>.module.css">` 幂等注入 —— 这样样式
 * 随 bundle 一起被 Cordis 的 Loader 条目回收，不需要额外加载 CSS 文件。
 * 本插件照此实现，类名统一加 `tp-` 前缀避免与页面冲突。
 *
 * 设计取值严格对齐《DSH_TaskPulse_V3.0_UI设计与开发规范》与 UI 原型：
 *   入口 120x32、圆角 12px、半透明玻璃；
 *   面板 360x600；状态色 蓝/黄/绿/红/橙；
 *   Timeline 三态 ✓ ● ○；执行中蓝色呼吸、异常红色提示、新增任务滑入。
 */

const PLUGIN_ID = 'dsh-taskpulse'
const TAG_ID = `${PLUGIN_ID}/taskpulse.css`

const CSS = `
.tp-root {
  position: absolute;
  top: var(--dsh-frame-overlay-top, 20px);
  right: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  /* 拖动改变位置时给出平滑过渡；拖动过程中由 [data-dragging] 关闭。 */
  transition: top var(--ds-transition-duration, .2s) var(--ds-ease-in-out, cubic-bezier(.4,0,.2,1)),
    left var(--ds-transition-duration, .2s) var(--ds-ease-in-out, cubic-bezier(.4,0,.2,1));
  /* 层本身穿透点击，只有实际控件接管事件，绝不遮挡聊天区（验收标准 1）。 */
  pointer-events: none;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif);
  color: var(--dsw-alias-label-primary, #1f2937);
}
.tp-root > * { pointer-events: auto; }

/* ---------- 默认态入口：120x32 / 圆角 12 / 半透明玻璃 ---------- */
.tp-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 120px;
  height: 32px;
  padding: 0 10px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2, #dbeafe);
  border-radius: 12px;
  background: var(--dsw-alias-button-floating-fill, rgba(255, 255, 255, .85));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(18px));
  color: var(--dsw-alias-state-business-primary, #2563eb);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 15px rgba(0, 0, 0, .08);
  transition: background var(--ds-transition-duration, .2s) var(--ds-ease-in-out, cubic-bezier(.4,0,.2,1));
  /* 拖动相关：胶囊是拖动把手，因此禁止浏览器把拖拽解释成文本选择/滚动。 */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
/* 可拖动时给出「抓手」光标；正在拖动时切成「抓取中」。 */
.tp-btn[data-draggable="true"] { cursor: grab; }
.tp-btn[data-draggable="true"][data-dragging="true"] { cursor: grabbing; }
/* 拖动过程关闭过渡与悬停反馈，否则胶囊会「追」着指针走。 */
.tp-root[data-dragging="true"] { transition: none; }
.tp-root[data-dragging="true"] .tp-btn { transition: none; box-shadow: 0 8px 22px rgba(0, 0, 0, .16); }
.tp-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .95)); }
.tp-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #2563eb); outline-offset: 1px; }
/* 入口图标（需求 6）——原来是 🟦 emoji，现换成 64x64 的 PNG。
   尺寸写死 18px 是为了不随 emoji 字体度量浮动：胶囊高 32px，
   18px 图标 + 上下各 7px 留白正好居中，和右侧 13px 文字视觉重量相当。
   border-radius 让图标自带的高光边缘与胶囊圆角不打架。 */
.tp-btn-icon {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  object-fit: contain;
  pointer-events: none;
}
.tp-btn-label { flex: 1 1 auto; text-align: left; white-space: nowrap; }
.tp-btn-count {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--dsw-alias-state-business-primary, #2563eb);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
/* 有异常时入口自身闪红，保证「快速发现异常」。 */
.tp-btn[data-alert="true"] { border-color: var(--dsw-alias-state-error-primary, #dc2626); color: var(--dsw-alias-state-error-primary, #dc2626); animation: tp-alert 1.6s ease-in-out infinite; }

@keyframes tp-alert {
  0%, 100% { box-shadow: 0 4px 15px rgba(0, 0, 0, .08); }
  50% { box-shadow: 0 0 0 4px rgba(220, 38, 38, .18); }
}
@keyframes tp-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .45; transform: scale(.82); }
}
@keyframes tp-slide-in {
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: none; }
}

/* ---------- 展开面板：360x600 ---------- */
/*
 * 面板是绝对定位的：位置与最大尺寸由 panel-geometry.ts 按「胶囊实时位置 + 窗口可用空间」
 * 算好后以内联样式给出。做成 absolute 而不是 flex 兄弟节点，是为了让面板能翻到胶囊
 * 上方展开（胶囊在下半屏时），而 flex 布局只能把它往下挤、挤出窗口被裁掉。
 */
.tp-panel {
  position: absolute;
  display: flex;
  flex-direction: column;
  width: 360px;
  height: 600px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 18px;
  background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, .88));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(18px));
  box-shadow: var(--dsw-elevation-panel, 0 15px 45px rgba(0, 0, 0, .15));
  overflow: hidden;
  animation: tp-slide-in var(--ds-transition-duration, .2s) var(--ds-ease-in-out, cubic-bezier(.4,0,.2,1));
}
.tp-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
}
.tp-panel-title { font-size: 14px; font-weight: 600; }
.tp-panel-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); margin-top: 2px; }
.tp-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer; font-size: 14px;
}
.tp-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05)); }

/* 任务统计（规范 3 第二段）——这一排同时就是状态筛选，因此带按钮语义：
   可点击、有 hover、选中时用对应状态色实心。

   ⚠️ 不换行（用户要求：「让这四个按钮保持在同一行内，按自适应大小排布，
   不换行」）。原来是 flex-wrap: wrap，一旦筛选生效多出「✕ 全部 N」
   那一枚，五枚就折到第二行，看起来像凭空多出一排控件。
   现在改成 nowrap + 允许收缩：
     - 胶囊 flex: 0 1 auto + min-width: 0，空间不够时按比例压缩；
     - white-space: nowrap 保留，压缩到极限时是内容被裁掉而不是折行
       （胶囊是 inline-flex，本身也不会内部换行）；
     - font-variant-numeric: tabular-nums 让数字等宽，压缩时宽度不抖。
   面板可用宽度约 324px，四枚常态胶囊约 272px，余量留给「✕ 全部」。 */
.tp-stats { display: flex; gap: 6px; padding: 12px 18px 4px; flex-wrap: nowrap; align-items: center; }
.tp-stat {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  flex: 0 1 auto; min-width: 0; overflow: hidden;
  padding: 6px 8px; border-radius: 12px;
  border: 1px solid transparent;
  background: var(--dsw-alias-fill-l1, #f3f4f6);
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 12px; white-space: nowrap; font-family: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, cubic-bezier(.4,0,.2,1));
}
.tp-stat:hover:not(:disabled) { filter: brightness(.96); }
.tp-stat:disabled { opacity: .45; cursor: default; }
.tp-stat[data-tone="blue"] { background: #dbeafe; color: #2563eb; }
.tp-stat[data-tone="yellow"] { background: #fef9c3; color: #ca8a04; }
.tp-stat[data-tone="green"] { background: #dcfce7; color: #16a34a; }
.tp-stat[data-tone="red"] { background: #fee2e2; color: #dc2626; }
.tp-stat[data-tone="orange"] { background: #ffedd5; color: #ea580c; }
/* 选中：加深为实心，一眼看出「现在在看哪一类」。 */
.tp-stat[aria-pressed="true"] { color: #fff; font-weight: 600; box-shadow: 0 1px 4px rgba(0, 0, 0, .18); }
.tp-stat[aria-pressed="true"][data-tone="blue"] { background: #2563eb; }
.tp-stat[aria-pressed="true"][data-tone="yellow"] { background: #ca8a04; }
.tp-stat[aria-pressed="true"][data-tone="green"] { background: #16a34a; }
.tp-stat[aria-pressed="true"][data-tone="red"] { background: #dc2626; }
.tp-stat[aria-pressed="true"][data-tone="orange"] { background: #ea580c; }
/* 滚动区 */
.tp-body { flex: 1 1 auto; overflow-y: auto; padding: 8px 12px 12px; }
.tp-body::-webkit-scrollbar { width: var(--dsh-scrollbar-width, 5px); }
.tp-body::-webkit-scrollbar-thumb { background: var(--dsh-scrollbar-thumb, rgba(0, 0, 0, .18)); border-radius: 3px; }
.tp-body::-webkit-scrollbar-thumb:hover { background: var(--dsh-scrollbar-thumb-hover, rgba(0, 0, 0, .3)); }

/* 空态 */
.tp-empty { padding: 40px 20px; text-align: center; color: var(--dsw-alias-label-tertiary, #9ca3af); font-size: 12px; line-height: 1.8; }
.tp-empty-icon { font-size: 26px; display: block; margin-bottom: 8px; opacity: .5; }

/* 工作区分组（规范 4/5） */
.tp-group { margin: 12px; padding: 12px; border-radius: 14px; background: var(--dsw-alias-fill-l1, #fafafa); }
.tp-group:first-child { margin-top: 4px; }
.tp-group-title { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.tp-group-title-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-group-counts { display: flex; gap: 6px; font-size: 11px; font-weight: 400; }
.tp-group-counts span { white-space: nowrap; }

/* 对话条目 */
.tp-conv { display: flex; align-items: center; gap: 6px; padding: 4px 0 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.tp-conv-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-conv-time { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); }

/* 任务卡片（规范 6） */
.tp-card {
  background: var(--dsw-alias-bg-layer-1, #fff);
  border-radius: 12px;
  padding: 12px;
  margin-top: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, .05);
  animation: tp-slide-in var(--ds-transition-duration-slow, .3s) var(--ds-ease-in-out, cubic-bezier(.4,0,.2,1));
}
.tp-card[data-clickable="true"] { cursor: pointer; }
.tp-card[data-clickable="true"]:hover { box-shadow: 0 6px 18px rgba(0, 0, 0, .1); }
.tp-card-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tp-card-title { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; min-width: 0; }
.tp-card-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-card-meta { margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); line-height: 1.6; }
.tp-card-meta-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-card-meta-key { color: var(--dsw-alias-label-tertiary, #9ca3af); }

/* 状态徽章（规范 7 色表） */
.tp-badge { flex: 0 0 auto; padding: 3px 8px; border-radius: 10px; font-size: 12px; line-height: 1.4; white-space: nowrap; }
.tp-badge[data-tone="blue"] { background: #dbeafe; color: #2563eb; }
.tp-badge[data-tone="yellow"] { background: #fef9c3; color: #ca8a04; }
.tp-badge[data-tone="green"] { background: #dcfce7; color: #16a34a; }
.tp-badge[data-tone="red"] { background: #fee2e2; color: #dc2626; }
.tp-badge[data-tone="orange"] { background: #ffedd5; color: #ea580c; }
.tp-badge[data-tone="gray"] { background: var(--dsw-alias-fill-l2, #f3f4f6); color: var(--dsw-alias-label-secondary, #6b7280); }

/* 状态圆点：执行中蓝色呼吸动画（规范 10） */
.tp-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #9ca3af); }
.tp-dot[data-tone="blue"] { background: #2563eb; animation: tp-breathe 1.4s ease-in-out infinite; }
.tp-dot[data-tone="yellow"] { background: #ca8a04; }
.tp-dot[data-tone="green"] { background: #16a34a; }
.tp-dot[data-tone="red"] { background: #dc2626; animation: tp-breathe 1.2s ease-in-out infinite; }
.tp-dot[data-tone="orange"] { background: #ea580c; }
.tp-dot[data-tone="gray"] { background: var(--dsw-alias-label-tertiary, #9ca3af); }

/* Timeline（规范 8 三态 ✓ ● ○） */
.tp-timeline { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.tp-timeline-row { display: flex; gap: 6px; padding: 2px 0; line-height: 1.6; }
.tp-timeline-mark { flex: 0 0 auto; width: 12px; text-align: center; }
.tp-timeline-mark[data-state="done"] { color: #16a34a; }
.tp-timeline-mark[data-state="active"] { color: #2563eb; }
.tp-timeline-mark[data-state="todo"] { color: var(--dsw-alias-label-tertiary, #9ca3af); }
.tp-timeline-mark[data-state="failed"] { color: #dc2626; }
.tp-timeline-action { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-timeline-time { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, #9ca3af); font-size: 11px; }
.tp-timeline-detail { padding-left: 18px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 进度条 */
.tp-progress { margin-top: 8px; height: 3px; border-radius: 2px; background: var(--dsw-alias-fill-l2, rgba(0, 0, 0, .08)); overflow: hidden; }
.tp-progress-bar { height: 100%; border-radius: 2px; background: var(--dsw-alias-state-business-primary, #2563eb); transition: width var(--ds-transition-duration-slow, .3s) var(--ds-ease-in-out, cubic-bezier(.4,0,.2,1)); }
.tp-progress-bar[data-tone="green"] { background: #16a34a; }
.tp-progress-bar[data-tone="red"] { background: #dc2626; }
.tp-progress-bar[data-tone="orange"] { background: #ea580c; }
.tp-progress-bar[data-tone="yellow"] { background: #ca8a04; }

/* 错误条 */
.tp-error { margin-top: 6px; padding: 6px 8px; border-radius: 8px; background: #fee2e2; color: #dc2626; font-size: 11px; line-height: 1.5; word-break: break-word; }

/* 确认卡片（规范 9） */
.tp-confirm { margin-top: 8px; padding: 10px 12px; border-radius: 12px; background: #fef9c3; border: 1px solid rgba(202, 138, 4, .25); }
.tp-confirm-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #ca8a04; }
.tp-confirm-body { margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); line-height: 1.6; }
.tp-confirm-actions { margin-top: 8px; display: flex; gap: 8px; }
.tp-confirm-hint { font-size: 11px; color: #a16207; opacity: .85; }
.tp-action {
  padding: 4px 10px; border-radius: 8px; border: 1px solid transparent;
  font-size: 12px; cursor: pointer;
  background: var(--dsw-alias-fill-l2, rgba(0, 0, 0, .05));
  color: var(--dsw-alias-label-primary, #1f2937);
}
.tp-action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .1)); }
.tp-action[data-primary="true"] { background: #ca8a04; color: #fff; }
.tp-action[data-primary="true"]:hover { background: #a16207; }

/* 历史卡片 */
.tp-history { background: var(--dsw-alias-bg-layer-1, #fff); border-radius: 12px; padding: 10px 12px; margin-top: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, .04); }
.tp-history[data-dim="true"] { opacity: .78; }

/* 底栏 */
.tp-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 18px; border-top: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280);
}
.tp-footer-btn { border: none; background: transparent; color: var(--dsw-alias-state-business-primary, #2563eb); font-size: 12px; cursor: pointer; padding: 4px 6px; border-radius: 8px; }
.tp-footer-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(37, 99, 235, .08)); }
.tp-footer-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); }

/* ---------- 状态变迁提示（需求 m04869） ---------- */
/*
 * 位置由内联样式给出（toast-geometry.ts 按胶囊实时位置算出上下与水平偏移），
 * 这里只描述外观与「贴哪一侧」。
 *
 * 上下偏移写死 40px = 胶囊高 32px + TOAST_GAP 8px，与几何模块保持一致。
 * 宽度 264px 同样与 TOAST_WIDTH 一致（改一处必须改另一处）。
 *
 * 插入动画：提示在胶囊上方时从上方滑入，在下方时从下方滑入，
 * 用 data-side 翻转 translateY 的符号，方向感才与位置一致。
 */
.tp-toasts {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 264px;
  box-sizing: border-box;
}
.tp-toasts[data-side="above"] { bottom: 40px; }
/* 上方展开时容器以底边为锚、按时间顺序自上而下堆叠 ⇒ 最新一条贴着胶囊。
   下方展开时锚点在顶边，必须反转视觉顺序，才能让最新一条同样最靠近胶囊
   （DOM 顺序保持时间序，仅反转呈现，读屏仍是时间序）。 */
.tp-toasts[data-side="below"] { top: 40px; flex-direction: column-reverse; }

.tp-toast {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  box-sizing: border-box;
  padding: 9px 10px 9px 12px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, .92));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(18px));
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, .12));
  text-align: left;
  font-family: inherit;
  animation: tp-toast-in var(--ds-transition-duration, .2s) var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
}
.tp-toasts[data-side="above"] .tp-toast { animation-name: tp-toast-in-up; }
.tp-toast[role="button"] { cursor: pointer; }
.tp-toast[role="button"]:hover { background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, .98)); }
.tp-toast[role="button"]:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #2563eb); outline-offset: 1px; }
/* 左侧状态色条：与 StatusBadge 同一套色表（规范 7），一眼区分是哪种变迁。 */
.tp-toast::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 0 3px 3px 0; background: currentColor; opacity: .85; }
.tp-toast-dot { flex: 0 0 auto; width: 8px; height: 8px; margin-top: 4px; border-radius: 50%; background: currentColor; }
.tp-toast-main { flex: 1 1 auto; min-width: 0; }
.tp-toast-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2937); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-toast-sub { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); }
.tp-toast-close {
  flex: 0 0 auto; width: 18px; height: 18px; padding: 0;
  border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-size: 11px; line-height: 18px; text-align: center; cursor: pointer;
}
.tp-toast-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06)); color: var(--dsw-alias-label-primary, #1f2937); }
.tp-toast[data-tone="blue"] { color: #2563eb; }
.tp-toast[data-tone="yellow"] { color: #ca8a04; }
.tp-toast[data-tone="green"] { color: #16a34a; }
.tp-toast[data-tone="red"] { color: #dc2626; }
.tp-toast[data-tone="orange"] { color: #ea580c; }
.tp-toast[data-tone="gray"] { color: #6b7280; }

@keyframes tp-toast-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes tp-toast-in-up {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
`

let injected = false

/** 幂等注入插件样式（与官方 UI 包同样的 dataset 标记）。 */
export function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
