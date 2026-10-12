# DSH TaskPulse

**中文** · [English](README.md)

一个 DSH（DeepSeek Harness）插件：在 DSH 窗口右上角以浮窗展示**当前正在执行的 AI 任务** ——
一个多工作区、多会话、多 Agent 的状态监控中心。

| 项 | 值 |
|---|---|
| 插件名 | `dsh-taskpulse` |
| 版本 | `1.5.0` |
| 目标 DSH | `0.2.0-rc.2` |
| 许可 | MIT |

---

## 简介

DSH 里同时开着好几个工作区、每个工作区又有好几条对话时，「哪个在跑、跑到哪一步、
哪个卡住了」很难一眼看清。TaskPulse 把这些状态收拢到右上角一个胶囊里：
不点开时只是一个带计数的入口，点开后是一块按工作区分组、带状态色和时间线的任务面板。

设计上遵守两条硬线：

1. **不干扰主对话** —— 浮窗挂在 DSH 官方的 `shell.overlay` 层上，该层本身点击穿透，
   只有胶囊与面板接管鼠标事件，因此**永远不会遮挡聊天区**。
2. **只读** —— 插件不修改用户内容、不代替用户执行任何操作（详见「权限边界」）。

---

## 特性

| 特性 | 说明 |
|---|---|
| 右上角胶囊入口 | `120×32` 半透明玻璃胶囊，实时显示活跃任务数；点击展开 `360×600` 面板。 |
| 胶囊可拖动 | 收起状态下可拖到 DSH 窗口内任意位置，越界自动钳制在窗口内，位置持久化。 |
| 状态变迁提示 | 收起状态下，任务新进入 `待确认 / 已达成 / 异常 / 阻塞` 时，胶囊上方或下方弹出一条小提示，写明是哪条对话、`由「进行中」变为「待确认」`；**5 秒后自动消失**。点提示可直接打开该对话详情，点 `✕` 可单独关掉。贴哪一侧由胶囊实时位置算出，不会被窗口裁掉。 |
| 面板自适应定位 | 面板按胶囊实时位置决定展开方向：下半屏时翻到胶囊上方，贴边时平移回窗口内，两侧都放不下时压缩高度 —— 无论胶囊拖到哪都不会被窗口裁掉。 |
| 不遮挡聊天区 | 挂载在官方 `shell.overlay` 插槽，层点击穿透，仅胶囊与面板接收事件。 |
| 按工作区分组 | 任务按 DSH 工作区分组，组头带状态计数，如 `🟦2运行 🟡1确认`。 |
| 列表只看状态与步骤 | 卡片只展示当前状态、当前步骤与 Agent；工具调用的执行流水留在详情视图。 |
| 状态筛选 | 顶部的状态统计胶囊本身就是筛选按钮：点 `🔴 异常 1` 只看异常，**再点同一枚**回到全部。这一排只有状态胶囊，不会追加「全部」按钮；始终同一行，不换行。 |
| 六状态模型 | `待开始 / 进行中 / 待确认 / 已达成 / 异常 / 阻塞`，对应蓝 / 黄 / 绿 / 红 / 橙。「待确认」覆盖 DSH **两种**等人方式：工具审批与 `ask_user_question` / 计划审批。 |
| 确认中心 | 汇总所有在等你的事 —— 工具审批**和** AI 的提问（`ask_user_question`、计划审批），展示 AI 建议或提问原文，一键跳回原对话处理；在任务详情视图内呈现。 |
| 历史归档 | 超过 24 小时无新操作的任务移出活跃列表并落盘持久化（归档不看状态：静默一整天的「运行中」事实上已死）。 |
| 会话数对齐侧栏 | 工作区标题里的会话数＝侧栏可见数（已注册 `sessionIds` − 归档）。 |
| 只读 | 不修改用户内容，不自动执行操作。 |

---

## 安装

从本地检出安装到某个 DSH profile：

```bash
npm install
npm run build

dsh plugin --profile <profile-name> add <本仓库路径>
```

该命令会在 profile 的 `package.json` 中写入 `link:` 依赖，并把插件登记进
`dsh.profile.bundles`。

> **安装后必须重启 DSH。** 浏览器半边的 bundle 只在启动时组合一次，
> 不重启界面上不会出现浮窗。

---

## 使用

1. 重启 DSH 后，右上角出现 `AI任务 <n>` 胶囊，`<n>` 是当前活跃任务数。
2. **点击**胶囊展开任务面板。
3. **拖动**胶囊（收起状态）可改变位置；位置会自动限制在窗口内，下次启动仍然生效。
4. 面板体就是按工作区分组的活跃任务列表；上方那排状态统计胶囊**本身就是筛选器**——
   点 `🔴 异常 1` 只看异常，再点一次回到全部。
5. 按 `Esc`、点击面板外、或点 `✕` 收起面板。
6. **收起之后它照样替你盯着**：任务新到达值得关注的状态
   （`待确认 / 已达成 / 异常 / 阻塞`）时，胶囊旁边会冒出一条小提示，5 秒后自己消失。
   点提示可直接跳到那条对话的详情；点提示上的 `✕` 只关掉这一条。

每张任务卡片只回答两个问题：**这条对话现在处于什么状态**、**正在做哪一步**。
执行流水（工具调用、子代理派生、完整时间线）属于详情视图，点开卡片即可看到。

---

## 架构

DSH 插件是**双半边**结构，两半边运行在不同进程，通过明确的通道通信：

```
┌──────────────────────── DSH 宿主进程（Node） ───────────────────────────┐
│  会话事件流                  cordis 事件            宿主服务             │
│  turn/start …                api-session/*          sessions, agents …  │
│         └──────────┬───────────────┘                                    │
│                    ▼                                                    │
│   EventService → TaskStore → TaskService → BridgeService                │
│                    connection.fetch.register('/api/dsh-taskpulse/*')    │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ 同源 HTTP（只读 GET，JSON）
┌──────────────────────────────▼──────────────────────────────────────────┐
│                     DSH Web GUI（浏览器）                                │
│   插槽标准 props  +  宿主快照   →   TaskPulseOverlay                     │
│   shell.overlay (list, scope=root)  →   右上角浮窗                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### 宿主半边

`src/index.ts`，Cordis 插件，`inject = ['workspaceRegistry', 'sessions']`。
订阅 DSH 真实的会话事件流（`session/event` 等），把事件折叠成任务状态，
再通过 `connection.fetch.register` 暴露三个**只读** GET 端点：

| 端点 | 用途 |
|---|---|
| `/api/dsh-taskpulse/snapshot` | 活跃任务、工作区分组、状态计数、待确认事项 |
| `/api/dsh-taskpulse/history` | 已归档任务 |
| `/api/dsh-taskpulse/ping` | 就绪探测 |

### 浏览器半边

`src/client/index.tsx`，Cordis 插件，`inject = ['slots']`。
向 `shell.overlay` 插槽注册一个条目，并把两路数据合并：

1. **插槽标准 props**（`useSessions` / `useSessionStatus` / `useWorkspaces`）——
   由 DSH 官方 UI 包提供，零延迟、权威的运行态；
2. **宿主快照** —— 补充浏览器半边拿不到的信息，如时间线、当前步骤，
   以及只存在于宿主事件流里的 `异常 / 阻塞` 结论。

宿主快照的轮询间隔：面板展开 **2 秒**、胶囊态 **5 秒**（要足够快才能支撑状态变迁提示）、
页面切到后台 **30 秒**。

之所以必须自建通道：DSH 浏览器侧的事件桥是**封闭白名单**，不转发
session / agent / tool 事件。

完整的接口契约（含每一条已确证的接口，以及规范事件名到 DSH 真实事件名的映射）
见 [`docs/插件与DSH主程序接口设计.md`](docs/插件与DSH主程序接口设计.md)。

---

## 权限边界

插件**严格只读**，这是设计决定，不是实现疏漏。

| 允许 | 禁止 |
|---|---|
| `workspace.read` | 修改用户内容 |
| `conversation.status.read` | 自动执行操作 |
| `task.read` | — |
| `timeline.read` | — |

插件唯一的写入，是写它**自己**的历史文件 `<DSH_HOME>/taskpulse/history.json`。

因此确认中心的按钮是 **「前往会话处理」**（审批）或 **「前往会话作答」**（提问），
而不是「批准」：它把你带回那条对话，由你在 DSH 原生界面里做决定。
插件绝不代替你批准、拒绝或作答。

---

## DSH 的两种「在等人」

DSH 里有两条**互相独立**的等人通道。只盯着其中一条的监控，注定有一半时间在说谎：

| 通道 | 由什么触发 | 宿主事件 | 卡片标题 |
|---|---|---|---|
| **审批** | 需要授权的工具 | `approval/asked` / `approval/decided` | `等待确认：` |
| **提问** | `ask_user_question`、`exit_plan_mode`（计划审批） | **没有** —— 宿主不追加任何事件 | `等待答复：` |

提问通道是最容易被漏掉的那条：agent 阻塞在 `ctx.userQuestions.ask()` 期间，
会话日志里只有一条普普通通的 `tool/call`，根本没有事件可供订阅。
所以 TaskPulse 在自己的 `tool/call` 处理里把
`ask_user_question` / `exit_plan_mode` 当作阻塞型工具，
并在配对的结果到达时（`data.message.toolCallId`）、或宿主记下答复时
（`source.kind === 'user-question-reply'` 的 `user/message`）解除等待。

浏览器半边在此之上再加一道零延迟的判断：DSH 会通过 `useSessionStatus`
发布每个会话的 `pendingInteraction`，TaskPulse 据此把已建档的任务提升为「待确认」。
只读的「回看卡」会被忽略 —— 能回头再看一眼的卡片，不是正在等你处理的卡片。

审批结论按真实词表匹配（只有 `allowed-once` 是放行，
`rejected` / `cancelled` / `unavailable` 都意味着工具**没有**执行），
所以被中止的审批显示为「阻塞」，而不是「进行中」。

---

## 开发

```bash
npm install
npm run build        # 宿主半边（tsc）+ 浏览器半边（esbuild）
npm run typecheck    # 两个 tsconfig，均不产出
npm test             # 八个套件，137 项断言
```

构建产物：

| 产物 | 由谁产出 |
|---|---|
| `dist/index.js` | `tsc -p tsconfig.json` |
| `dist/client/index.js` | `node scripts/build-client.mjs`（esbuild） |

浏览器 bundle 会被包装成 DSH 的模块加载形式：

```js
window.__ModuleLoader__.load({ id: 'dsh-taskpulse', factory: (require) => { … } })
```

### 目录结构

```
src/
├── index.ts          # 宿主半边入口（Cordis 插件）
├── client/index.tsx  # 浏览器半边入口（插槽注册）
├── models/           # 共享纯净层 —— 类型、状态机、标签
├── store/            # 任务 Store、历史 Store、客户端侧合并
├── services/         # 事件服务、任务服务、HTTP 桥、客户端 API
├── hooks/            # useHostData（轮询）、useCapsuleDrag（拖动）、
│                     # usePanelGeometry（面板定位）、panel-geometry（纯几何）、
│                     # useStatusToasts + useToastSide、toast-geometry（纯几何）
├── components/       # TaskButton、TaskPanel、WorkspaceGroup、ConversationItem、
│                     # TaskCard、TaskDetail、StatusBadge、Timeline、
│                     # ConfirmCard、HistoryCard、StatusToast
└── styles/           # 注入式 CSS
```

开发规范点名的 8 个组件齐备；`ConfirmCard` 与 `HistoryCard` 为额外补充。

### 测试

| 套件 | 断言数 | 覆盖内容 |
|---|---|---|
| `test/models.test.mjs` | 18 | 状态机、计数、归档规则、格式化、工具标签 |
| `test/drag.test.mjs` | 13 | 胶囊拖动：边界钳制、持久化、越界回弹 |
| `test/panel.test.mjs` | 15 | 面板定位：向上/向下展开、横向平移、高度压缩 |
| `test/toast.test.mjs` | 29 | 状态变迁提示：变迁侦测、仅胶囊态、5 秒到期、上下贴边 |
| `test/store.test.mjs` | 18 | 双路合并口径：状态收敛、归档剔除、工作区归属、会话数 |
| `test/taskflow.test.mjs` | 13 | 状态流转：提问/审批两条通道、答复回落、回归保护 |
| `test/components.test.mjs` | 23 | 渲染结果 —— 列表只显示状态与当前步骤、状态筛选、无重复按钮、提示卡片 |
| `test/bundle.test.mjs` | 8 | 模块加载契约、external 表、插槽注册 |

合计 **137 项断言**；`node scripts/run-all-tests.mjs` 会打印各套件与总计。

---

## 已知限制

- 浏览器半边只能 `require` 页面冻结的 9 个 seed 模块（`react`、`react/jsx-runtime`、
  `react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`）。引入其它依赖必须在打包时内联。
- DSH 客户端插槽没有 `useJobs` 标准 props，因此后台长任务不在展示范围内。
- 任务状态从插件加载那一刻开始累积；官方已弃用的 `Session.snapshotEvents()`
  被刻意回避，不做历史回放。

---

## 许可

[MIT](LICENSE) © 2026 DSH TaskPulse contributors
