# DSH TaskPulse

[中文文档](README.md) · **English**

A DSH (DeepSeek Harness) plugin that shows **what the AI is working on right
now** in a floating panel at the top-right corner of the DSH window — a
multi-workspace, multi-conversation, multi-agent status monitor.

- Plugin name: `dsh-taskpulse`
- Version: `2.0.0`
- Target DSH: `0.2.0-rc.2`
- License: MIT

---

## Features

| Feature | Description |
|---|---|
| Top-right capsule | A `120×32` glass capsule showing the live active-task count. Click to expand a `360×600` panel. |
| Draggable capsule | While collapsed, drag the capsule anywhere inside the DSH window. The position is clamped to the window bounds and remembered across sessions. |
| Status-change toast | While collapsed, a small toast pops above or below the capsule whenever a task newly enters `待确认 / 已达成 / 异常 / 阻塞`, naming the conversation and the transition (`由「进行中」变为「待确认」`). It fades out by itself after **5 seconds**, can be clicked to open that conversation's detail, or dismissed early with `✕`. Which side it appears on is computed from the capsule's live position, so it is never clipped. |
| Adaptive panel placement | The panel is positioned from the capsule's live location: it flips above the capsule in the lower half of the window, shifts back inside when the capsule hugs an edge, and caps its height when neither side fits — so it is never clipped, wherever the capsule was dragged. |
| Never covers chat | Mounted on DSH's official `shell.overlay` slot, whose layer is click-through; only the capsule and panel accept pointer events. |
| Per-workspace grouping | Tasks are grouped by DSH workspace with inline status counters, e.g. `🟦2运行 🟡1确认`. |
| Status-only list | Cards show the current status, current step and agent; the tool-call stream stays in the detail view. |
| Status filter | The status counters double as filter buttons: click `🔴 异常 1` to see errors only, **click the same pill again** to return to all. The row holds nothing but the status pills — no "全部" button is appended — and always stays on one line. |
| Six-state model | `待开始 / 进行中 / 待确认 / 已达成 / 异常 / 阻塞`, colour-coded blue / yellow / green / red / orange. `待确认` covers **both** ways DSH waits for you: tool approvals and `ask_user_question` / plan review. |
| Confirmation centre | Surfaces everything that is waiting on you — tool approvals **and** questions the AI asked (`ask_user_question`, plan review) — with the AI's suggestion or the question text, so you can jump to the conversation and answer. Rendered inside the task detail view. |
| History | Tasks idle for more than 24 hours move out of the active list and are persisted to disk (archiving ignores status — a `RUNNING` task silent for a day is in fact dead). |
| Sidebar-aligned counts | Each workspace header reports the session count the DSH sidebar shows (registered `sessionIds` − archived). |
| Read-only | The plugin never edits your content and never acts on your behalf. |

---

## Installation

Install into a DSH profile from a local checkout:

```bash
npm install
npm run build

dsh plugin --profile <profile-name> add <path-to-this-repo>
```

The command records a `link:` dependency in the profile's `package.json` and
registers the plugin in `dsh.profile.bundles`.

> **Restart DSH after installing.** The browser-half bundle is composed once at
> startup, so the panel will not appear until DSH is restarted.

---

## Usage

1. Restart DSH. A capsule labelled `AI任务 <n>` appears at the top-right corner,
   where `<n>` is the number of active tasks.
2. **Click** the capsule to expand the task panel.
3. **Drag** the capsule (while collapsed) to reposition it. Positions are kept
   inside the window automatically and restored on the next launch.
4. The panel body is the active task list, grouped by workspace. The statistics
   row above it **is** the status filter: click `🔴 异常 1` to see only failures,
   click it again to go back to all.
5. Press `Esc`, click outside, or press `✕` to collapse the panel.
6. **Leave it collapsed** and it will keep working for you: a small toast pops next
   to the capsule whenever a task newly reaches a state worth knowing about
   (`待确认 / 已达成 / 异常 / 阻塞`), then disappears on its own after 5 seconds.
   Click the toast to jump straight into that conversation's detail; click `✕`
   on the toast to dismiss just that one.

Each task card answers exactly two questions: **what state is this conversation
in**, and **which step is it on**. Execution detail (tool calls, subagent
spawns, full timeline) lives in the detail view you reach by clicking a card.

---

## Architecture

DSH plugins have two halves that run in different processes and communicate over
an explicit channel.

```
┌──────────────────────── DSH host process (Node) ────────────────────────┐
│  session event stream        cordis events        host services         │
│  turn/start …                api-session/*        sessions, agents, …   │
│         └──────────┬───────────────┘                                     │
│                    ▼                                                     │
│   EventService → TaskStore → TaskService → BridgeService                 │
│                    connection.fetch.register('/api/dsh-taskpulse/*')     │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ same-origin HTTP (read-only GET, JSON)
┌──────────────────────────────▼───────────────────────────────────────────┐
│                     DSH web GUI (browser)                                │
│   slot standard props  +  host snapshot   →  TaskPulseOverlay            │
│   shell.overlay (list, scope=root)        →  top-right floating panel    │
└──────────────────────────────────────────────────────────────────────────┘
```

**Host half** — `src/index.ts`, a Cordis plugin with
`inject = ['workspaceRegistry', 'sessions']`. It subscribes to the real DSH
event stream (`session/event`) and folds events into task state, then exposes
three read-only GET endpoints via `connection.fetch.register`:

| Endpoint | Purpose |
|---|---|
| `/api/dsh-taskpulse/snapshot` | active tasks, workspace groups, counters, pending confirmations |
| `/api/dsh-taskpulse/history` | archived tasks |
| `/api/dsh-taskpulse/ping` | readiness probe |

**Browser half** — `src/client/index.tsx`, a Cordis plugin with
`inject = ['slots']`. It registers an entry into the `shell.overlay` slot and
merges two sources:

1. **Root standard props** (`useSessions`, `useSessionStatus`, `useWorkspaces`)
   contributed by DSH's own UI packages — zero-latency, authoritative run state.
2. **The host snapshot** — supplies what the browser half cannot see, such as the
   timeline, current step and `异常 / 阻塞` outcomes, which exist only in the
   host-side event stream.

The host snapshot is polled at **2 s** while the panel is expanded, **5 s** while
collapsed (fast enough to feed the status-change toasts), and **30 s** while the
page is in the background.

A host-side channel is required because DSH's browser-side event bridge is a
closed whitelist that does not forward session, agent or tool events.

Full contract details, including every verified interface and the mapping from
the spec's event names to DSH's real ones, are in
[`docs/插件与DSH主程序接口设计.md`](docs/插件与DSH主程序接口设计.md).

---

## Permissions

The plugin is **strictly read-only**, by design.

| Allowed | Forbidden |
|---|---|
| `workspace.read` | Modifying user content |
| `conversation.status.read` | Executing actions automatically |
| `task.read` | — |
| `timeline.read` | — |

The only write the plugin performs is to its **own** history file at
`<DSH_HOME>/taskpulse/history.json`.

Consequently, the confirmation centre's buttons read **「前往会话处理」** (approvals)
or **「前往会话作答」** (questions) rather than "Approve": they navigate you back
to the conversation, and you make the decision in DSH's native UI. The plugin
never approves, rejects or answers on your behalf.

---

## Two ways DSH waits for you

DSH has two independent "waiting for a human" channels, and a monitor that watches
only one of them will lie to you half the time:

| Channel | Triggered by | Host event | Card |
|---|---|---|---|
| **Approval** | A tool that needs permission | `approval/asked` / `approval/decided` | `等待确认：` |
| **Question** | `ask_user_question`, `exit_plan_mode` (plan review) | *none* — the host appends nothing | `等待答复：` |

The question channel is the subtle one: while the agent is blocked on
`ctx.userQuestions.ask()`, the session log contains nothing but an ordinary
`tool/call`, so there is no event to react to. TaskPulse therefore treats
`ask_user_question` / `exit_plan_mode` as blocking tools in its own `tool/call`
handler, and clears the wait when the matching result arrives
(`data.message.toolCallId`) or when the host records the reply
(`user/message` with `source.kind === 'user-question-reply'`).

The browser half adds a second, zero-latency opinion on top: DSH publishes a
per-session `pendingInteraction` through `useSessionStatus`, and TaskPulse
promotes an existing task to 待确认 from it. Read-only "review" cards are
ignored — a card you can look back at is not a card that is waiting on you.

Approval outcomes are matched against the real vocabulary
(`allowed-once` is the only grant; `rejected` / `cancelled` / `unavailable` all
mean the tool did **not** run), so a cancelled approval reads as 阻塞 rather than
「进行中」.

---

## Development

```bash
npm install
npm run build        # host half (tsc) + browser half (esbuild)
npm run typecheck    # both tsconfigs, no emit
npm test             # eight suites, 137 assertions
```

Build output:

| Artifact | Produced by |
|---|---|
| `dist/index.js` | `tsc -p tsconfig.json` |
| `dist/client/index.js` | `node scripts/build-client.mjs` (esbuild) |

The browser bundle is wrapped in DSH's module-loader form:

```js
window.__ModuleLoader__.load({ id: 'dsh-taskpulse', factory: (require) => { … } })
```

### Source layout

```
src/
├── index.ts          # host-half entry (Cordis plugin)
├── client/index.tsx  # browser-half entry (slot registration)
├── models/           # shared pure layer — types, state machine, labels
├── store/            # task store, history store, client-side merge
├── services/         # event service, task service, HTTP bridge, client API
├── hooks/            # useHostData (polling), useCapsuleDrag (dragging),
│                     # usePanelGeometry (placement), panel-geometry (pure math),
│                     # useStatusToasts + useToastSide, toast-geometry (pure math)
├── components/       # TaskButton, TaskPanel, WorkspaceGroup, ConversationItem,
│                     # TaskCard, TaskDetail, StatusBadge, Timeline,
│                     # ConfirmCard, HistoryCard, StatusToast
└── styles/           # injected CSS
```

The eight components named in the development spec are all present; `ConfirmCard`
and `HistoryCard` are additional.

### Tests

| Suite | Assertions | Covers |
|---|---|---|
| `test/models.test.mjs` | 18 | state machine, counters, archiving, formatting, tool labels |
| `test/drag.test.mjs` | 13 | capsule drag: clamping, persistence, bounds |
| `test/panel.test.mjs` | 15 | panel placement: flip above/below, horizontal shift, height cap |
| `test/toast.test.mjs` | 29 | status-change toasts: transition detection, collapsed-only gating, 5-second expiry, above/below placement |
| `test/store.test.mjs` | 18 | merge rules: status convergence, archive filtering, workspace ownership, counts |
| `test/taskflow.test.mjs` | 13 | status flow: question/approval channels, reply fallback, regressions |
| `test/components.test.mjs` | 23 | rendered output — status/step only, status filter, no duplicate button row, toast card |
| `test/bundle.test.mjs` | 8 | module-loader contract, externals, slot registration |

137 assertions in total; `node scripts/run-all-tests.mjs` prints the per-suite and
grand totals.

---

## Known limitations

- The browser half may only `require` the nine modules frozen into the page's
  platform seed table (`react`, `react/jsx-runtime`, `react-dom`,
  `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-dockkit`). Any other dependency must be inlined at
  bundle time.
- DSH's client slots provide no `useJobs` standard prop, so background jobs are
  not surfaced.
- Task state is accumulated from the moment the plugin loads; the deprecated
  `Session.snapshotEvents()` API is deliberately not used to replay history.

---

## License

[MIT](LICENSE) © 2026 DSH TaskPulse contributors
