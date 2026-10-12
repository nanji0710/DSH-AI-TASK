# DSH TaskPulse —— 插件与 DSH 主程序接口设计

> 本文回答任务要求 1：**插件与 DSH 主程序的接口设计、任务数据的结构与获取方式**。
>
> 所有接口均来自对 DSH `0.2.0-rc.2` 安装包的逐行逆向确证（`app.asar` → `node_modules/@deepseek-ai/*`），
> 不包含任何推测。凡与三份规范中描述不一致之处，本文显式标注差异并给出映射。

---

## 1. 总体架构：一个插件，两个半边

DSH 插件是**双半边**结构，两半边运行在不同进程、使用不同的模块系统，只能通过明确的通道通信：

```
┌─────────────────────────── DSH 宿主进程（Node） ───────────────────────────┐
│                                                                            │
│   session 事件流            cordis 事件            宿主服务                  │
│   turn/start …             api-session/*          ctx.sessions             │
│        │                        │                 ctx.workspaceRegistry     │
│        └────────┬───────────────┘                 ctx.agents               │
│                 ▼                                                          │
│      ┌──────────────────────┐                                              │
│      │  宿主半边 (src/)      │  EventService → TaskStore → TaskService      │
│      │  dist/index.js       │                    │                         │
│      └──────────────────────┘                    ▼                         │
│                                        BridgeService                        │
│                              connection.fetch.register(/api/dsh-taskpulse/*)│
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │  同源 HTTP（GET，JSON）
┌──────────────────────────────────▼─────────────────────────────────────────┐
│                        浏览器（DSH Web GUI 页面）                            │
│                                                                            │
│   槽位系统                    标准 props                                     │
│   ctx.slots                   useSessions / useSessionStatus /             │
│        │                      useWorkspaces                                 │
│        └──────────┬────────────────────┘                                   │
│                   ▼                                                        │
│      ┌──────────────────────────┐                                          │
│      │  浏览器半边 (src/client)  │  TaskPulseOverlay → TaskButton/TaskPanel │
│      │  dist/client/index.js    │                                          │
│      └──────────────────────────┘                                          │
│                   │                                                        │
│        shell.overlay（list, scope=root）→ 右上角浮窗                        │
└────────────────────────────────────────────────────────────────────────────┘
```

**为什么必须两个半边**：`tool/call`、`turn/start`、`todo/write` 等会话事件只在宿主侧流动，浏览器半边
**永远拿不到**（详见 §5.3 白名单证据）。因此 Timeline / 当前步骤只能由宿主半边归约后经 HTTP 下发。

---

## 2. 宿主半边接口

### 2.1 Cordis 插件入口契约

```ts
// src/index.ts
export const inject = ['workspaceRegistry', 'sessions']   // ⚠️ Cordis 服务名，不是包名
export function apply(ctx: any): void { /* … */ }
export default { name: 'dsh-taskpulse', inject, apply }
```

| 项 | 值 | 说明 |
|---|---|---|
| `inject` | `['workspaceRegistry', 'sessions']` | 填**服务名**。`workspaceRegistry` 是 `@deepseek-ai/dsh-workspace` 注册的服务名（**不是** `workspaces`），见该包 `lib/index.js:374` `super(ctx, "workspaceRegistry")` |
| `connection` | **不可**写进顶层 `inject` | 它是 Web 载体专有服务，纯 CLI 下不存在；写进去会让插件在 CLI 下永久等待。必须用 `ctx.inject(['connection'], cb)` 惰性获取 |
| 导出 | `apply` / `default` | Cordis Loader 按包名加载 `main`（`dist/index.js`） |

### 2.2 事件订阅接口（`ctx.on(name, handler)`）

订阅全部由 Cordis 在本插件 fiber 卸载时自动回收，无需手工 dispose。

| 事件名 | 载荷签名 | 本插件用途 |
|---|---|---|
| `session/event` | `(session, event)` | **Timeline 的唯一来源**。`event = { type, seq, time, data }`，见 §2.3 |
| `session/created` | `(session)` | 新会话 → 建任务（规范 `conversation.created`） |
| `session/disposed` | `(session)` | 会话销毁 → 任务落 History |
| `api-session/added` | `(summary)` | 会话进入列表基线 |
| `api-session/removed` | `(sessionId)` | 会话移除 |
| `api-session/status` | `(sessionId, running: boolean)` | **运行/停止的主信号**（规范 `conversation.finished`） |
| `api-session/error` | `(sessionId, error)` | 异常 → `ERROR` 状态 |
| `agent/status` | `({ agent, status })` | `status ∈ 'idle' \| 'running'`，兜底运行态（仅在真变化时发射） |
| `domain/changed` | `(change)` | `change.domain === 'workspace'` 时刷新会话→工作区归属 |

### 2.3 `session/event` 事件词汇与载荷

`event` 形状：`{ type, seq, time, data }`，由 `Session.append(type, data)` 产生（`dsh-session/lib/index.js:1441`）。
`data` 保证 JSON 可序列化。本插件消费：

| `event.type` | `event.data` 关键字段 | Timeline 映射 |
|---|---|---|
| `turn/start` | `{ turn }` | 新轮次（`第 N 轮`） |
| `turn/end` | `{ turn, reason }` | `reason.kind === 'error'` → `ERROR`；`'aborted'` → `BLOCKED`；`null` → `SUCCESS` |
| `step/start` | `{ turn, step }` | 步骤计数 +1，当前步骤「思考中」 |
| `step/end` | `{ turn, step }` | 步骤完成（✓） |
| `tool/call` | `{ turn, step, callId, name, arguments }` | 见下方「两条等人通道」：`name` 为阻塞型提问工具时置 `WAIT_CONFIRM`，否则 `RUNNING`；**「当前执行：xxx」**（`toolLabel(name)` 译成中文动作） |
| `tool/result` | `{ turn, step, message, error?, meta? }` | 工具完成（✓ / ✕）；`message.toolCallId` 与 `tool/call` 的 `callId` 配对，命中挂起项则回 `RUNNING` |
| `assistant/message` | `{ message: { content } }` | assistant 输出（●） |
| `user/message` | `{ source, content }` | 用户输入（✓）；`source.kind === 'user-question-reply'` 时解除提问挂起 |
| `todo/write` | `{ todos: [{content,status}] }` | 任务清单变更 |
| `approval/asked` | `{ id, toolName, callId?, reason? }` | **`WAIT_CONFIRM`**（`pendingConfirm.kind = 'approval'`） |
| `approval/decided` | `{ id, outcome }` | `outcome === 'allowed-once'` → `RUNNING`；其余（`rejected` / `cancelled` / `unavailable`）→ `BLOCKED` |
| `session/title` | `{ title, messageSeqs, source }` | 任务标题更新 |

#### 两条等人通道（`WAIT_CONFIRM` 的两个来源）

DSH 里「等用户」有两条**互相独立**的通道，只订阅其中一条会漏掉一半场景：

| 通道 | 触发 | 宿主事件 | `pendingConfirm.kind` |
|---|---|---|---|
| 审批 | 需要授权的工具 | `approval/asked` / `approval/decided` | `'approval'` |
| 提问 | `ask_user_question`、`exit_plan_mode` | **无** —— 阻塞期间不追加任何事件 | `'question'` |

提问通道的关键事实：`dsh-tool-ask-user` 经 `ctx.userQuestions.ask()` 阻塞等待，
`dsh-plan-mode` 的 `exit_plan_mode` 走同一个 `userQuestions` 面；
两者在会话流里**只留下一条普通 `tool/call`**，因此插件在自己的 `tool/call`
分支把这两个工具名视为阻塞型（`BLOCKING_ASK_TOOLS`），
并在下列任一时机解除：配对 `callId` 的 `tool/result` 到达、
`source.kind === 'user-question-reply'` 的 `user/message` 写入。

浏览器半边另有一路零延迟信号 `useSessionStatus().get(id).pendingInteraction`，
但 DSH 会把「只读回看卡」（`PendingQuestion.review` 非空）也发布进同一字段，
故需按该字段过滤后再提升为 `WAIT_CONFIRM`。

### 2.4 宿主服务接口

| 服务 | 方法 / 属性 | 本插件用法 |
|---|---|---|
| `ctx.sessions` | `get(id)` → live Session \| `undefined` | 取会话实例（`session.id` 作为任务主键） |
| | `list()` → `Session[]`（创建序） | 启动种子：把已在运行的会话纳入监控 |
| `ctx.workspaceRegistry` | `list()` → `Workspace[]` | 工作区分组（UI 规范 4） |
| | 实体 `id` / `path` / `title` / `updatedAt` / `sessionIds` | 归属解析：`sessionIds.includes(sessionId)` → `workspaceId` |
| `ctx.agents` | `get(id)` → AgentHandle，`.status` | 启动种子时判定 `running` |

⚠️ **`Session.snapshotEvents()` / `eventAt()` 已被官方标记 deprecated**（`Agent Note 2026-09-09-deprecate-synchronous-session-event-reads`）。
本插件**不做历史回放**：Timeline 从插件启用后开始累积，避免踩弃用接口。

### 2.5 跨半边 HTTP 通道（`connection.fetch.register`）

```ts
ctx.inject(['connection'], (connCtx: any) => {
  const connection = connCtx.connection
  if (connection?.fetch?.register === undefined) {
    ctx.logger?.warn?.('[taskpulse] connection.fetch 不可用，浏览器半边将退化为本地状态源')
    return
  }
  connection.fetch.register({
    path: '/api/dsh-taskpulse/snapshot',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => json(200, body)
  })
})
```

| 约束 | 值 |
|---|---|
| `path` | 必须 `/api/` 开头，每段匹配 `/^[A-Za-z0-9_$.-]+$/` |
| 端点 | `/api/dsh-taskpulse/snapshot`、`/history`、`/ping` |
| 响应 | `{ 'content-type': 'application/json; charset=utf-8' }`；错误也返回 **HTTP 200** + `{ ok:false, error }`（错误不静默） |
| 浏览器侧 | 直接 `fetch(相对路径)`，同源，**无需任何注入** |

> **⚠️ 死路备忘**：不要使用 `connection.rpc.handle()` / `rpc.call()`。其内部执行
> `owner.effect(() => owner.webServer.register(route))`，而 `owner` 经 Cordis traceable 转发后拿不到
> `webServer`，抛 `cannot get property "webServer" without inject` **并被吞掉** ⇒ 通道静默失效（端点恒 404/405）。
> `connection.fetch.register` 不触碰 `owner.webServer`，是唯一可行方案。

---

## 3. 浏览器半边接口

### 3.1 包声明（`package.json`）

```json
{
  "exports": {
    ".":          { "default": "./dist/index.js" },
    "./client":   { "default": "./dist/client/index.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-ui-workspace"
      ]
    }
  }
}
```

| 键 | 填什么 | 依据 |
|---|---|---|
| `exports["./client"]` | 客户端 bundle 路径 | **bundle 路径的唯一来源**。宿主解析器（`dsh-client-modules/lib/index.js:61-75`）只认 `platform` / `inject` / `external` / `immediately` 四项 —— `dsh.client.entry` **不被读取**（参考插件的 `entry` 键是无效残留） |
| `dsh.client.inject` | **包名** | 保证被注入的包先于本插件加载（插槽由 layout 声明） |
| `dsh.client.platform` | `'web'` | 非 web 不被收集 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 决定该包能否作为 profile 层激活 |

### 3.2 Cordis 客户端入口契约

```ts
export const name = 'dsh-taskpulse'
export const inject = ['slots']        // ⚠️ Cordis 服务名（不是包名！）
export function apply(ctx: any): void { /* … */ }
export default { name, inject, apply }
```

> **两个 inject 极易混淆**（官方文档 §3.2 / §10.3 明确列为常见坑）：
> 源码 `inject` 填**服务名**（`['slots']`），`package.json` 的 `dsh.client.inject` 填**包名**。
> 把包名写进源码 `inject` ⇒ 插件永远等待一个不存在的服务，UI 静默不出现。
>
> 缺 `inject` 时 `ctx.slots` 的代理 getter 会沿 fiber 父链抛
> `cannot get property "slots" without inject`，**整个插件 fiber 直接 FAILED**。

### 3.3 插槽注册（挂载点）

`shell.overlay` —— 由 `dsh-client-ui-layout` 的 `root` 条目声明的 `list` 插槽，`scope: "root"`：

```ts
ctx.slots.inject('shell.overlay', () =>
  ctx.slots.register(
    { name: 'shell.overlay', id: 'taskpulse.overlay', order: 100, label: 'AI TaskPulse' },
    TaskPulseOverlay
  )
)
```

| 项 | 值 | 说明 |
|---|---|---|
| 插槽 | `shell.overlay` | 全局浮层；官方已有 10 个占用者（quota-notice、refresh-toast、shortcuts…） |
| `kind` | `list` | 可以有多个条目，必须带 `id` |
| `scope` | `root` | 条目白拿 root 标准 props（§3.4） |
| `order` | 数字 | 仅 list 生效，决定同层顺序 |
| 必须用 `inject` | ✔ | 插槽由父条目在 `children` 里声明，**声明顺序不保证**；直接 `register` 未声明的槽位会抛 `slot "X" is not declared` |

**点击穿透是官方保证的**：overlay 层为 `pointer-events: none`，且
`.overlayLayer > * { pointer-events: auto }` —— 插槽内容自动恢复可点击，**绝不遮挡聊天区**（验收标准 1）。
本插件在此之上再包一层 `.tp-root { pointer-events: none }` + `.tp-root > * { pointer-events: auto }`，
确保只有真实的按钮/面板接住事件，容器本身永远穿透。

### 3.4 root 标准 props（白拿的数据源）

渲染器把 `provideRoot({ hooks })` 贡献物物化成组件 props，命名规则
`standardHookPropName(name) = 'use' + Name[0].toUpperCase() + Name.slice(1)`（`dsh-client-ui-slots/lib/index.js`）：

| prop | 贡献者 | 快照形状 |
|---|---|---|
| `useSessions(selector, isEqual?)` | `dsh-client-ui-session` | `{ ids: string[], byId: Record<id, Row>, phase, projectionsBySession }` |
| `useSessionStatus(selector, isEqual?)` | `dsh-client-ui-session` | `Map<sessionId, { running?, pendingInteraction?, completionUnread }>` |
| `useWorkspaces(selector, isEqual?)` | `dsh-client-ui-workspace` | `{ items: WorkspaceView[], archivedSessionIds, pinnedSessionIds, state, phase, error }` |
| `usePanelInfo` / `useResource(key)` / `useSessionRetainInfo(key)` | layout / resources / session | 本插件未使用 |

**`SessionRow` 字段**（`dsh-api-session-controller/lib/client.js` `projectList()`）：
`{ id, displayTitle, running, retainedBy, blank, updatedAt /* ms */, projectionValues?, title?, cwd?, parentId?, origin? }`
- `origin === 'subagent'` → 子代理会话（本插件归入父会话，不单列）
- `blank === true` → 空会话（不占任务列表）
- `projectionValues.agentPreset` → **Agent 名**（如 `DeepSeek-Coder`）

> ⚠️ **没有 `useJobs`**：`ctx.jobs` 不是 root 标准源，需自行 `inject: ['jobs']` 才可用。本插件未依赖它。
> ⚠️ selector 默认相等性是 `Object.is`，**必须返回稳定引用**（本插件只选 `snapshot.ids` / `snapshot.byId` / `snapshot.items`）。

### 3.5 样式注入

照抄官方 UI 包的 idiom（`dsh-client-ui-jobs/lib/client.js:10-19`）——CSS 内联进 bundle，幂等注入，随 Loader 条目回收：

```ts
const TAG_ID = 'dsh-taskpulse/taskpulse.css'
if (document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-taskpulse'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
```

类名统一 `tp-` 前缀；颜色/圆角/过渡优先取 DSH 主题变量并带 fallback，
如 `var(--dsw-alias-state-business-primary, #2563eb)`、`var(--dsw-radius-md, 12px)`、`var(--dsh-frame-overlay-top, 20px)`。
⚠️ DSH **没有间距 token**（403 个 `--dsw-*` 中无 `--dsw-space-*`），间距按官方做法写死 px。

### 3.6 bundle 加载契约

浏览器半边**不是 ESM、也不是普通 CJS**，而是 `window.__ModuleLoader__.load({ id, factory })`
包装的 factory-form CJS（`require` 由宿主注入，模块副作用在首次物化时才运行）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-taskpulse',
  factory: (require) => {
    var module = { exports: {} }
    /* … CJS 内容 … */
    return module.exports
  }
})
```

由 `scripts/build-client.mjs` 用 esbuild 的 `banner` / `footer` 自动套上（`id` 必须等于包名）。

**`external` 必须恰好等于页面的冻结平台 seed 表**（`assets/index-*.js` 的 `PLATFORM_MODULES`，
共 9 项）——这是**唯一**可被 `require` 的裸 id 集合：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

> ⚠️ 裸 `cordis` **不在表内**（只有 `@deepseek-ai/cordis`）。多写一个会抛
> `client-modules: require("…") missed the module table — not a platform seed word, not a materialized module,
> and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`。
> 本插件只 external `react` 与 `react/jsx-runtime`（实测 bundle 内 `require` 调用仅此两项），
> 由 `test/bundle.test.mjs` 在 CI 中把关。

### 3.7 定位（右上角）

```css
.tp-root {
  position: absolute;
  top: var(--dsh-frame-overlay-top, 20px);   /* 自动避让 macOS/Windows 标题栏与全屏 */
  right: 20px;
}
```

`--dsh-frame-overlay-top = calc(var(--dsh-frame-top-clearance) + 20px)`，官方定义在
`dsh-client-ui-layout/lib/client.js:73`，取值：Windows `60px` / macOS `68px` / 全屏 `20px`。
使用同一变量的官方先例：`dsh-client-ui-settings-general/lib/client.js:60`、`dsh-client-ui-schedule/lib/client.js:3091`。

---

## 4. 任务数据结构

### 4.1 规范模型 → 实现模型

三份规范给出的模型（§3 数据模型）在 DSH 中的**真实对应物**：

| 规范模型 | DSH 真实对应物 | 说明 |
|---|---|---|
| `Workspace { id, name, path, conversations }` | `ctx.workspaceRegistry.list()` → `{ id, path, title, sessionIds, createdAt, updatedAt }` | `title` ≈ `name`；`sessionIds` 取代嵌套 `conversations`（避免环形引用） |
| `Conversation { id, workspaceId, title, lastActivityTime, tasks }` | 一个 DSH **会话**（session） | 本插件把「1 会话 = 1 任务」作为主粒度（DSH 中一次对话就是一条任务流） |
| `AgentTask { id, title, status, progress, currentStep, lastActionTime, timeline }` | `TaskDetail`（§4.2） | 字段全部保留，另补 `agent` / `model` / `turn` / `error` / `pendingConfirm` 等 |
| `Timeline { 时间, 操作, 状态, 输出 }` | `TimelineEntry`（§4.2） | `time` / `action` / `status` / `detail` |

> ⚠️ 规范里的 `tasks: AgentTask[]`（一个 Conversation 多个 Task）在 DSH 中**没有对应概念**：
> DSH 的会话内部是 `turn → step → tool` 三层，不存在「同一会话下并列多个任务」。
> 本插件的处理：**1 会话 = 1 当前任务**，会话内的 turn/step 展开为 Timeline。
> 这保证了 UI 规范 5（Conversation 展示「对话名称 + 当前任务 + 最近动作时间」）能如实呈现。

### 4.2 核心结构（`src/models/types.ts`）

```ts
/** 任务主键 = 会话 id。这是「当前正在执行的任务」的权威描述。 */
interface TaskDetail {
  id: string; sessionId: string; workspaceId: string | null
  title: string
  status: TaskStatus            // START | RUNNING | WAIT_CONFIRM | SUCCESS | ERROR | BLOCKED
  progress: number              // 0..1，启发式（DSH 不暴露总步数）
  currentStep: string | null    // 「当前执行：执行命令」
  currentDetail: string | null  // 参数摘要
  agent: string | null          // agentPreset 投影
  model: string | null
  startedAt: number             // 对话创建时间（会话维度基准）
  runStartedAt: number | null   // 本轮起点，仅由该对话自己的事件写入；未见则 null
  lastActionTime: number; finishedAt: number | null
  turn: number; step: number; toolCalls: number; steps: number
  error: string | null
  pendingConfirm: PendingConfirm | null
  timeline: TimelineEntry[]     // 上限 40 条，尾部最新
}

interface TimelineEntry { time: number; action: string; detail?: string; status: TimelineState; seq?: number }
type TimelineState = 'done' | 'active' | 'todo' | 'failed'   // 规范 8：✓ ● ○ ✕

interface PendingConfirm { kind: 'approval' | 'question'; id: string; toolName: string; callId?: string; reason?: string; preview?: string; time: number }
/** conversationCount = 侧栏可见会话数（已注册 sessionIds − 归档）；counts.total = 本插件活跃任务数。 */
interface WorkspaceGroupView { id; name; path; conversationCount; counts: StatusCounts; updatedAt }
interface StatusCounts { running; waitConfirm; success; error; blocked; total }
interface HistoryItem { id; sessionId; workspaceId; workspaceName; title; status; startedAt; finishedAt; duration: number | null; steps; toolCalls; error; summary }
```

**Store 形状**（规范三 §3：`{ workspaces: [{ id, name, conversations: [] }] }`）在实现中体现为
`TaskStore` 持有的 `Map<sessionId, TaskRecord>`，并由 `TaskService.getWorkspaces()` 按 `workspaceId`
聚合出 `WorkspaceGroupView[]`（含状态计数）。扁平 Map + 派生分组比嵌套树更快，且天然避免环形引用。

### 4.4 状态变迁提示（1.5.0，需求 m04869）

「任务新进入一个状态就弹提示」这条需求**不引入任何新的数据源** —— 它是
`TaskDetail.status` 在时间轴上的**派生视图**。全部逻辑落在
`src/models/status-transition.ts`（纯函数，零依赖）与
`src/hooks/use-status-toasts.ts`（把纯函数接到 React 上）。

```ts
// 变迁侦测：拿一份长期存活的状态账本逐次比对
type StatusLedger = Map<string, TaskStatus>
interface StatusTransition { sessionId: string; title: string; from: TaskStatus | undefined; to: TaskStatus; at: number }
interface StatusToast extends StatusTransition { id: string }

function diffStatuses(ledger: StatusLedger, tasks: readonly TaskDetail[], at?: number): StatusTransition[]
function admitTransitions(transitions: readonly StatusTransition[], capsule: boolean): readonly StatusTransition[]
function mergeToasts(current: readonly StatusToast[], incoming: readonly StatusTransition[], limit?: number): readonly StatusToast[]
function pruneToasts(toasts: readonly StatusToast[], now: number, ttl?: number): readonly StatusToast[]
```

| 规则 | 取值 | 理由 |
|---|---|---|
| 触发时机 | 每次 `tasks` 变化（面板展开态 2s / 胶囊态 5s 轮询，或标准 props 变化） | 不需新增订阅：状态本来就是这两路合并的结果 |
| 只提示哪些状态 | `TOAST_STATUSES = [WAIT_CONFIRM, SUCCESS, ERROR, BLOCKED]` | **刻意不含 `RUNNING` / `START`** —— 每轮对话开始、每次工具调用都会回到 `RUNNING`，提示它等于给每个动作弹窗 |
| 首次观测 | 只记账、不提示 | 插件刚加载时不该把已有的状态重播一遍 |
| 任务消失 | 只清账本 | 归档 / 删除不是状态变迁 |
| 重新出现 | 按首次观测处理 | 宁可少提示，也不补报陈旧变迁 |
| 胶囊态判定 | `useStatusToasts(view.tasks, !expanded)` | 需求原话：「**如果当前处于胶囊状态**」。面板展开时状态变化就在眼前的列表里，再弹一条只会遮挡内容 |
| 展开态是丢弃还是排队 | **丢弃**（`admitTransitions(t, false) === []`） | 排队会让用户收起面板时一次性炸出一批已经过时的提示 |
| 存活时长 | `TOAST_TTL_MS = 5000` | 需求：5 秒后自动消失。按**时间戳**判定而非序号 —— 同会话提示被替换时会续期，序号计数会让它提前消失 |
| 队列上限 | `TOAST_LIMIT = 3` | 批量收尾时不至于刷满屏幕 |
| 同会话重复进入同一状态 | 替换并续期 | 不堆成一摞 |
| 贴哪一侧 | `placeToast({ capsule, overlay })` → `{ side, left }` | 胶囊可拖到窗口任意位置（m01719），上下哪侧有空间必须算出来；`left` 是**相对胶囊左缘**的偏移，因此再拖胶囊时提示自动跟随 |

按时间戳判定还带来一个实现上的好处：5 秒这个数字只存在于
`TOAST_TTL_MS` 一个常量里，测试用假时钟卡在 `4999ms` 与 `5000ms` 两点断言即可，
不需要在界面上掐秒表（见 `test/toast.test.mjs`）。

### 4.3 状态机（规范 4）

```
START ──► RUNNING ──► ┌ SUCCESS
          │  ▲        ├ ERROR
          │  │        ├ WAIT_CONFIRM ──► RUNNING（用户确认后继续）
          ▼  │        └ BLOCKED
       （合法转移表见 src/models/task-state.ts）
```

| 状态 | 触发来源（DSH 真实事件） | UI 色 |
|---|---|---|
| `START` | `api-session/added`（会话已建、尚未运行） | 灰 |
| `RUNNING` | `api-session/status → true`、`turn/start`、`step/start`、`tool/call` | 蓝 |
| `WAIT_CONFIRM` | `approval/asked`；或 `tool/call` 且 `name ∈ { ask_user_question, exit_plan_mode }` | 黄 |
| `SUCCESS` | `turn/end` 且 `reason === null` | 绿 |
| `ERROR` | `api-session/error`、`turn/end` 且 `reason.kind === 'error'`、`tool/result` 带 `error` | 红 |
| `BLOCKED` | `turn/end` 且 `reason.kind === 'aborted'` | 橙 |

**浏览器半边的合成口径**：标准 props 补齐出来的卡片**不会**取 `START`。
`START` 的语义严格限定为「本宿主进程刚建档、尚未收到任何事件」；而合成路径面对的是
**已经存在、很可能早已结束**的历史会话，它没有「待开始」这回事。因此合成时的状态阶梯是：

```
pendingInteraction ≠ null  →  WAIT_CONFIRM
running === true           →  RUNNING
其余                        →  SUCCESS
```

早先这里最后一支写 `START`，于是每个空闲会话都挂成「待开始」**且永远不变**：合成任务
只活在浏览器内存里，宿主的 24 小时 `sweep()` 根本看不到它们，既不会归档也不会收敛。

**自动隐藏（规范 6）**：超过 24 小时（`INACTIVE_ARCHIVE_AFTER_MS`）无新动作 ⇒ 移出活跃列表
并写入 History。与规范原文的三点差异，均为实测后的有意选择：

1. 阈值 30 分钟 → 24 小时（用户要求「超过一天没有新操作就归到历史中」）；
2. **不再限定 `SUCCESS`** —— 静默一整天的 `RUNNING` 事实上已经死了，继续显示「运行中」才是误报；
3. 归档状态**按当前状态如实记录**，不伪装成成功。

> 注：上面第 1 条的「30 分钟」指**规范 6 原定值**，实现中从未发布过该阈值。

归档不等于删除：`HistoryItem` 仍可在持久化文件里回看。
`ERROR` / `BLOCKED` 在 24 小时内不隐藏 —— 异常必须能立刻看见（规范 1「快速发现异常」）。

**归档剔除的落点在两处**：宿主 `TaskStore.sweep()` 负责本进程建档的任务；浏览器半边
`buildViewModel` 另外按 `archivedSessionIds` 过滤 —— 后者才是与侧栏口径对齐的关键，
因为侧栏可见性判据正是「不在归档集合里」。`dsh-workspace` 明确说明归档**不会**把会话
移出 `workspace.sessionIds`（unarchiving must restore the position），所以必须显式扣除。

---

## 5. 数据获取方式

### 5.1 双路合并

浏览器半边同时使用两个数据源，各有不可替代之处：

| 路 | 来源 | 提供 | 缺失时后果 |
|---|---|---|---|
| **A** | root 标准 props（`useSessions` / `useSessionStatus` / `useWorkspaces`） | 会话目录、运行态、待确认、工作区归属 —— **零延迟** | 无法显示新会话 |
| **B** | `/api/dsh-taskpulse/snapshot`（宿主半边） | Timeline、当前步骤、工具调用数、轮次、错误详情、History | 卡片退化为「有状态无机细节」 |

合并规则（`src/store/client-store.ts` `buildViewModel`）：
1. 宿主快照优先（信息最全）；
2. 标准 props 补齐宿主尚未覆盖的会话（合成最小卡片，无 Timeline）；
3. 标准 props 的 `running` 是**权威信号**，用于校正宿主快照的滞后运行态
   （但它**不会**把「待确认」冲成「进行中」—— 等人期间 agent 仍在运行态）；
4. 标准 props 的 `pendingInteraction` 是**第二路待确认信号**（零延迟）；
   按 DSH 的「只读回看卡」（`review` 非空）过滤后，把非终态任务提升为 `WAIT_CONFIRM`，
   信号消失且 `running === true` 时回落 `RUNNING`；
5. 工作区计数以实际任务重算；工作区标题的会话数取侧栏口径
   （`sessionIds` 扣除 `archivedSessionIds`）。

轮询策略（`src/hooks/use-host-data.ts`）：**面板展开时 2s、胶囊态 5s、页面不可见 30s**。
选择轮询而非 SSE 的理由：本插件的实时性需求是「秒级」，每次请求都是 KB 级 JSON，
轮询无长连接泄漏风险，且更符合「不干扰主对话」原则。

> **收起态为何不再暂停（1.5.0 起）**：需求 m04869 要求「胶囊态也能发现状态变迁」，
> 而 `异常 / 阻塞` 这类结论只存在于**宿主半边**的会话事件流里
> （浏览器半边的 `pendingInteraction` / `running` 看不到它们）。
> 收起时若完全不取数，就等于「你不在看的时候发生的事永远不会被提示」。
> 因此收起态改为 5s 低频取数 —— 5s 与提示自身的存活时长（5s）同量级，
> 最坏情况下变迁晚 5 秒被看到，随后仍能完整显示 5 秒。

### 5.2 事件流（规范 5 硬性链路）

```
DSH Event            →  Event Service        →  Task Store      →  UI 刷新        →  History 保存
ctx.on('session/event')  src/services/          src/store/         /snapshot 轮询     HistoryStore
ctx.on('api-session/*')    event-service.ts      task-store.ts      → React 渲染       history.json
```

### 5.3 ⚠️ 规范事件名与 DSH 真实事件名的映射

**规范三里列举的 8 个事件名在 DSH 中全部不存在**。这是本文最重要的差异说明：

| 规范事件名 | DSH 真实来源 | 备注 |
|---|---|---|
| `workspace.created` | `domain/changed`（过滤 `change.domain === 'workspace'`） | 工作区**没有专门事件** |
| `workspace.removed` | 同上 | |
| `workspace.updated` | 同上 | |
| `conversation.created` | `session/created`、`api-session/added` | |
| `conversation.updated` | `session/event`（`turn/start`、`step/start`、`tool/call`…） | |
| `conversation.finished` | `api-session/status`（`running === false`）、`session/disposed` | |
| `agent.started` / `agent.finished` | `api-session/status`（由 `agent/status` 派生） | |
| `agent.progress` | `session/event` 的 `step/start`、`tool/call` | |
| `tool.called` / `tool.finished` | `session/event` 的 `tool/call`、`tool/result` | |
| `task.updated` | 以上归约后的派生结果 | 不是独立事件 |

映射实现集中在 `src/services/event-service.ts` 头部表格，便于审计。

**为什么浏览器半边拿不到这些事件**：`ctx.remote.$on` 的键集是**封闭白名单**
（`@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js` `API_REMOTE_FORWARDED_EVENTS`，仅 27 项），
且全宿主只允许一个 forwarded source（已被 `dsh-api-remotes` 占用，重复注册直接抛错）。
典型后果：`agent/status` **不在**白名单，浏览器半边收不到；`session/event` 更是完全不在。
⇒ 这就是 §2.5 必须自建 HTTP 通道的根本原因。

---

## 6. 权限边界（规范 8）

| 规范允许 | 实现 |
|---|---|
| `workspace.read` | `ctx.workspaceRegistry.list()` + `useWorkspaces` |
| `conversation.status.read` | `useSessionStatus` + `api-session/status` 订阅 |
| `task.read` | `TaskService.getActiveTasks()` / `getConversations()` |
| `timeline.read` | `ctx.on('session/event')` 只读订阅 |

| 规范禁止 | 实现保证 |
|---|---|
| 修改用户内容 | 无任何 `session.append` / 草稿写入调用；`TaskService` 对外方法**全部是读** |
| 自动执行操作 | 无 `ctx.jobs.kill` / `agent.cancel` / 命令执行；唯一写操作是把终态任务写进**插件自己的** `history.json` |

> **确认中心的只读设计**：规范 9 要求「确认按钮」，但规范 8 禁止代替用户操作。
> 因此 `ConfirmCard` 的按钮**不是**「批准/拒绝」写入开关，而是「前往会话处理」（审批）
> 与「前往会话作答」（提问）——把用户带回触发等待的会话，由用户在原生的 DSH 界面里完成决策。
> 无回调时退化为一行提示：「请在对应会话中处理/作答（本插件只读）」。

---

## 7. 已确证的限制

| 限制 | 影响 | 本插件的处理 |
|---|---|---|
| 浏览器半边只能 `require` 9 个冻结 seed 模块 | 不能用 `@deepseek-ai/dsh-client-ui-primitives` 之外的 UI 包 | 只依赖 `react` / `react/jsx-runtime`；自绘组件 + 主题变量 |
| `ctx.clientModules` bundle 缺失 ⇒ 激活失败 | 必须先 `npm run build` | `prepack` 钩子自动构建；README 明确记录 |
| `Session.snapshotEvents()` 已弃用 | 不能回放历史 Timeline | Timeline 从插件启用后累积 |
| 客户端的 projection face 仅 6 个（`goal`/`inbox`/`modelSelection`/`permissions`/`plan`/`userQuestions`） | **拿不到 todo / turnOutline 投影** | 「当前步骤」由宿主侧 `tool/call` 派生 |
| 无 `--dsw-space-*` 间距 token | 无法完全 token 化 | 间距按官方做法写死 px，颜色/圆角/过渡仍取 token |
| `dsh.client.entry` 不被读取 | 写它会让人误以为生效 | 本插件只写 `exports["./client"]`，并在 README 标注该坑 |

---

## 8. 文件与接口对照

| 接口 | 实现文件 |
|---|---|
| Cordis 宿主入口 / `inject` | `src/index.ts` |
| 事件订阅 → Store 的桥（规范 §5 第二段） | `src/services/event-service.ts` |
| 任务归约（规范 §5 第三段） | `src/store/task-store.ts` |
| 规范 §7 五项核心接口 | `src/services/task-service.ts` |
| 跨半边 HTTP 通道 | `src/services/bridge.ts` |
| History 持久化 | `src/store/history-store.ts` |
| 共享数据模型与状态机 | `src/models/types.ts`、`src/models/task-state.ts`、`src/models/tool-labels.ts` |
| Cordis 客户端入口 / 插槽注册 | `src/client/index.tsx` |
| 双路合并 | `src/store/client-store.ts` |
| 轮询 hook | `src/hooks/use-host-data.ts` |
| 胶囊拖动与边界钳制 | `src/hooks/use-capsule-drag.ts` |
| 面板定位纯几何 | `src/hooks/panel-geometry.ts` |
| 面板定位 DOM 测量 | `src/hooks/use-panel-geometry.ts` |
| 插槽标准 props 类型 | `src/store/inject-types.ts` |
| 样式注入 | `src/styles/taskpulse-css.ts` |
| bundle 包装 | `scripts/build-client.mjs` |
| 契约自检 | `test/models.test.mjs`、`test/drag.test.mjs`、`test/panel.test.mjs`、`test/toast.test.mjs`、`test/store.test.mjs`、`test/taskflow.test.mjs`、`test/components.test.mjs`、`test/bundle.test.mjs`（`scripts/run-all-tests.mjs` 汇总，共 137 项断言） |
