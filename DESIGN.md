# dsh-ub-workflow 设计文档

> 版本：0.1 草案
> 目标：为 DSH 主界面新增一个 “UB 工作流” 视图，驱动 `ub-drv-develop` 仓库的
> AI 多 Agent 内核驱动开发工作流（ub-leader），并将工作流的每一步渲染为
> “步骤卡片 + 连线” 的实时进展图。

---

## 1. 背景与目标

### 1.1 背景

`D:\ai_work\ai_workspace\ub-drv-develop\ub-drv-develop` 是一套面向 UnifiedBus
内核驱动的 opencode 多 Agent 工作流源码：

- `agents/ub-leader.md` 定义统一编排器：路由 → 计划确认 → dispatch subagent → 门禁 → closeout。
- `skills/ub-workflow/routing.md` 定义阶段链（`routing-plan → requirement+design → design-gate → develop → test → review → (verify) → closeout`）。
- `skills/ub-workflow/workflow-gates.md` 定义硬门禁（需用户确认）与自动门禁。
- 每次变更在 `ub-workspace/changes/<change-id>/` 下产出结构化 artifact。

当前该工作流只能在 opencode TUI/CLI 中黑盒运行，缺少一个可视化 “控制塔”：
看不到当前跑在哪个阶段、该阶段是否在等待用户、每个阶段是否成功。

### 1.2 目标

新建 DSH 插件 `dsh-ub-workflow`（本地开发路径
`D:\ai_work\deepseekHarness\dsh-plugins\dsh-ub-workflow`），实现：

1. **主界面扩展新视图**：通过 DSH 浏览器半区的 `conversation.view` 槽位注册
   “UB 工作流” tab，作为会话视图环的一员。
2. **步骤卡片**：工作流的每一个步骤一张卡片，展示
   - 步骤名 / 序号 / 状态徽章
   - 是否 **需要用户介入**（硬门禁 / 澄清 / 阻塞）
   - 开始 / 完成时间、当前产物、最近事件摘要
3. **连线**：卡片之间用 SVG 连线连接，连线颜色随下游步骤状态变化
   （灰=pending，蓝=running，琥珀=等待用户，绿=done，红=failed）。
4. **真实执行能力**：宿主半区启动 `opencode run` 执行 ub-leader 工作流，
   以 “产物监听 + 事件流解析” 双通道还原实时进展。
5. **用户接入**：等待用户态步骤高亮显示操作按钮；用户确认/取消/调整后，
   插件将动作持久化并尽力续跑 opencode 会话。

### 1.3 非目标（首版不做）

- 不重写/内联 ub-leader 的编排决策（设计上的兜底，不替代 opencode）。
- 不把 compile/test/review/verify 拆成可单独触发的入口（与仓库门禁约束一致）。
- 不做多仓库并行 run（一个 run = 一个 change 工作流）。
- 不实现模块知识库 UI 编辑器。

---

## 2. 总体架构

```
┌─────────────────────────── DSH 插件 dsh-ub-workflow ───────────────────────────┐
│                                                                                │
│  宿主半区 (src/index.ts, runs in DSH host process)                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  WorkflowStore   —— 运行记录的权威状态（内存 + JSON 文件持久化）           │   │
│  │  WorkflowEngine  —— 阶段链推导、状态机推进、门禁判定                       │   │
│  │  ArtifactWatcher —— 轮询 ub-workspace/changes/<change-id>，产物→步骤完成    │   │
│  │  OpenCodeRunner  —— spawn `opencode run --format json`，流式解析事件       │   │
│  │  LoopbackRoutes  —— /api/ub-workflow/*（仅 loopback）                     │   │
│  │  SettingsSection —— 插件默认配置（repo 路径、opencode bin、轮询周期）      │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                │ loopback HTTP (127.0.0.1)                     │
│  浏览器半区 (src/client/index.ts, runs in DSH Web GUI)                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  register `conversation.view` 槽位 → “UB 工作流” tab                     │   │
│  │  WorkflowFlowView  —— 1s 轮询 API → 步骤卡片 + SVG 连线（监控/门禁确认）    │   │
│  │  SlashCommand      —— /ub-workflow 从会话输入框触发，无需进入本页          │   │
│  │  GateActionBar     —— 等待用户步骤的 确认/取消 操作                         │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│  核心纯逻辑 (src/core/*, framework-free, 可单测)                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  stages.ts       —— 步骤/阶段链定义（源自 routing.md）                     │   │
│  │  stateMachine.ts —— 状态迁移                                            │   │
│  │  artifacts.ts    —— 产物→阶段完成规则（源自 catalog.yaml / gates）         │   │
│  │  opencodeEvents.ts —— 开放事件行解析（宽容解析，永不 throw）               │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 为什么用 `conversation.view` 槽位

- `onversation.session` 是 single 且被对话根占用，替代它会失去聊天区。
- `conversation.view` 是 **list** 槽位：注册一个条目就是新增一个会话视图 tab
  （与 trajectory/waterfall 视图同级），由会话正文按 `only: <active id>` 单开渲染。
- 它天然是 session 作用域：组件可拿到 `sessionId`，便于把 “运行” 与 DSH 会话关联，
  同时不破坏现有 UI。

### 2.2 为什么采用 “宿主半区 + 浏览器半区”

沿用 `dsh-safeguard` 已验证的双半区模式：

- 宿主半区跑在 DSH 进程中，可以直接 `spawn` 子进程（opencode）、读文件系统、
  注册 loopback HTTP 路由，不受浏览器沙箱限制。
- 浏览器半区只做 UI 和数据读取，通过 loopback 路由轮询宿主状态。
  所有写操作（启动 / 确认 / 停止）也走 loopback 路由，宿主统一鉴权。

---

## 3. 步骤模型

### 3.1 阶段链定义（来自 routing.md）

| 流程类型 | 触发 | 阶段链 |
|---|---|---|
| `design-only` | `--stage design` | `routing-plan` → `requirement` → `design` → `design-gate`（终点） |
| `dev` | 默认 | `routing-plan` → `requirement` → `design` → `design-gate` → `develop` → `test` → `review` → `closeout` |
| `full` | `--mode full` + `--deploy` | dev 链 + `verify`（插在 review 与 closeout 之间） |
| `explore` | `--mode explore` | `explore`（单步） |

### 3.2 步骤实体

```ts
interface WorkflowStep {
  id: StepId                // 稳定语义 id，见下表
  title: string             // 中文标题
  description: string       // 一句话说明
  status: StepStatus        // pending | running | waiting_user | done | failed | skipped
  needsUser: boolean        // 是否为硬门禁/澄清类步骤（需要用户接入）
  artifactHints: string[]   // 该步骤完成应出现的产物（相对 change workspace）
  substeps?: WorkflowStep[] // develop 的子步骤（implement/patch/pre-review/compile-fix）
  startedAt?: string
  finishedAt?: string
  note?: string             // 最近一次进展摘要
  error?: string
}
```

### 3.3 步骤 ID 与产物映射

| id | 标题 | 需要用户 | 完成判定的关键产物 |
|---|---|---|---|
| `routing-plan` | 路由与流程计划 | ✅（0d 计划确认） | `<workspace>/.dsh-ub/plan-confirmed.json`（插件确认回执）或 workflow.started 存在 |
| `requirement` | 需求分析与澄清 | ✅（澄清问题 + 清单确认） | `requirement_analysis.md` |
| `design` | 详细设计 / delta spec / STC | ❌ | `detailed_design.md` + `delta/<domain>/spec.md` |
| `design-gate` | 设计门禁 | ✅ | 插件确认回执（用户确认设计） |
| `develop` | 编码实现（含子步骤） | ❌ | `implementation_notes.md` + `patch/*.patch` + `patch_report.md` + `pre_review_report.md` + `compile_report.md` |
| `develop.implement` | 代码实现 | ❌ | `implementation_notes.md` |
| `develop.patch` | 社区合规补丁 | ❌ | `patch/*.patch` + `patch_report.md` |
| `develop.pre-review` | 编码后质量预检 | ❌ | `pre_review_report.md` |
| `develop.compile` | 远程编译 + 自动修复 | ✅（仅在失败耗尽时） | `compile_report.md` |
| `test` | 单元测试与覆盖率 | ❌ | `test_report.md` |
| `review` | 代码审查 | ❌ | `module_review_report.md` |
| `verify` | 部署与 STC 验证（full） | ✅（deploy-ok 硬门禁） | `deploy_report.md` (+ `stc_exec_report.md`) |
| `closeout` | 交付归档 | ❌ | `workflow_report.md` + `archive_report.md` |
| `explore` | 探索模式 | ❌ | `exploration_notes.md` |

> `routing-plan` 与 `design-gate` 在仓库语义中是硬门禁，不是有独立产物的阶段；
> 它们的状态由流程状态机驱动：前驱完成后进入 `waiting_user`，用户操作后进入 `done`。

### 3.4 develop 子步骤

`develop` 是单次 dispatch 内部串行执行（实现 → patch → pre-review → 编译 + fix）。
UI 将 `develop` 渲染为一个 **卡片组**：父卡显示汇总状态，内部 4 个子卡以
较小的横向卡展示，子卡之间也有连线。父卡状态 = 子卡聚合（任一 failed→failed；
任一 running→running；全部 done→done）。

---

## 4. 宿主半区设计

### 4.1 WorkflowStore

- 内存 Map（runId → WorkflowRun），并持久化到
  `<repo>/.dsh-ub-workflow/runs.json`（工作仓库内，不污染 skill 目录）。
- 同一 repo 同时最多 1 个活跃 run（避免多个 opencode 进程写同一 change workspace）。
- `snapshot()` 输出 JSON-safe 对象，供 loopback 路由使用。
- run 记录：

```ts
interface WorkflowRun {
  runId: string
  repoPath: string
  sessionId?: string          // DSH 会话 id（浏览器端关联）
  changeId?: string           // 运行后从 workspace 目录探测或由用户指定
  mode: 'design-only' | 'dev' | 'full' | 'explore'
  module?: string
  requirement: string         // 用户原始需求原文
  status: 'idle' | 'running' | 'waiting_user' | 'done' | 'failed' | 'stopped'
  steps: WorkflowStep[]
  createdAt: string
  updatedAt: string
  pid?: number
  exitCode?: number | null
  logTail: string[]
}
```

### 4.2 WorkflowEngine（状态机）

状态迁移规则（核心）：

```
create run → 根据 mode 生成阶段链 → 所有步骤 pending
start → 第一个步骤 running + spawn opencode
事件/产物到达 → 当前 running 步骤 done → 下一个：
  - 若下一步 needsUser=false 且不是终点 → running
  - 若下一步 needsUser=true → waiting_user（并暂停推进，等待用户动作）
  - 若为终点 → run done
用户 confirm-gate → 该步 done → 下一步 running；需要时调用 OpenCodeRunner.continue()
用户 cancel/stop → run stopped/failed
进程退出且 exitCode != 0 且未 closeout → run failed（错误附在最近未完成步骤）
进程退出且 closeout 完成 → run done
```

### 4.3 产物轮询 ArtifactWatcher

- 每 1500ms 扫描 `<repo>/ub-workspace/changes/<latest-change-id or 指定 change-id>/`。
- 用文件存在性 + 非空大小判定步骤完成（见 3.3 映射表）。
- 仅能把未完成步骤推进为 done，不允许回退。
- `change-id` 解析顺序：用户显式传入 > 最新修改的 `changes/<id>` 子目录 > `-`（未探测到）。

### 4.4 OpenCodeRunner（执行通道）

**启动**

- 解析 opencode 可执行：配置 `opencodeBin`（默认自动探测，顺序为
  `OPENCODE_BIN_PATH` → `%USERPROFILE%\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode`
  经 `node` 执行）。
- 参数（使用 opencode 原生 CLI）：

```bash
node <opencode-bin> run \
  --dir <repoPath> \
  --format json \
  --session <runId>          # 使会话 id 对插件可见，便于后续 --continue
  --title "dsh-ub-workflow: <module>/<changeId>"
  --agent ub-leader?         # 可选；若 opencode 已注册 ub-leader 为 primary agent
  "<--module ... 等显式参数行 + 用户原始需求>"
```

> 说明：`--agent ub-leader` 依赖 opencode agent 配置是否可见；首版不强制，
> 若仓库的 `agents/` 已能被 opencode 发现并使用 primary 路由，则走自然路由；
> 否则将 `agents/ub-leader.md` 写入的显式提示词作为后备。

**流式解析（宽容策略）**

`src/core/opencodeEvents.ts` 逐行解析事件 JSON（每行一个事件对象，具体
schema 以运行时 opencode 版本为准）。解析器面对未知字段一律忽略、永不 throw：

- 提取 `sessionId`/`id` 字段（会话绑定）。
- 提取消息文本追加到当前步骤 `note`（截断至最近 400 字符）。
- 提取 tool call 名称，命中 `task`/`question`/`todo_write` 时更新运行现场
  （如 `question` → 若前驱步骤已完成且当前步骤 needsUser → waiting_user）。
- 进程 stdout/stderr 尾部保留为 `logTail`。

**续跑确认协议**

opencode `run` 单次是非交互的；ub-leader 会在硬门禁处使用 question 类型工具等待输入。
插件的策略：

1. run 启动时以插件生成的 `runId` 作为 opencode session id（`--session <runId>`）。
2. 状态机判定进入 `waiting_user` 后，UI 显示确认按钮。
3. 用户点击后，宿主执行
   `node <opencode-bin> run --dir <repo> --session <runId> --continue "确认，开始执行 ..."`
   以续跑同一会话；若原进程仍在运行，先停止原进程（保存其已有产物）。
4. 若 `--continue` 失败或不可用，插件降级：记录用户动作，
   不做自动续跑，并在 UI 提示用户“opencode 进程已暂停，请用户在线下 TUI 中继续或改写需求后重跑”。

> 首版此协议标记为 **best-effort**；产物到达是步骤推进的唯一硬依据，续跑只负责
> 传递用户决定。该组合保证即使续跑失败，UI 展示的进展也绝不虚报。

### 4.5 Loopback 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ub-workflow/state` | 返回当前活跃 run 的摘要状态（轮询用） |
| GET | `/api/ub-workflow/runs` | 返回全部 run |
| GET | `/api/ub-workflow/runs/:id` | 返回单个 run 详情 |
| POST | `/api/ub-workflow/run` | 创建并启动一个 run（body: repoPath/requirement/module/mode/changeId/sessionId） |
| POST | `/api/ub-workflow/run/:id/gate` | 确认/取消一个 waiting_user 门禁（body: stepId + action） |
| POST | `/api/ub-workflow/run/:id/stop` | 停止 run（kill 子进程） |
| DELETE | `/api/ub-workflow/runs/:id` | 删除历史 run（顺带移除持久化记录） |

所有路由沿用 `dsh-safeguard` 的 loopback-only 判定（127.0.0.1 / ::1 / ::ffff:127.0.0.1）。

### 4.6 设置

- 设置命名空间 `ub-workflow`（schemastery schema）：

```ts
{
  enabled:      boolean  // 默认 true
  repoPath:     string   // 默认 D:\ai_work\ai_workspace\ub-drv-develop\ub-drv-develop
  opencodeBin:  string   // 默认 ""（自动探测）
  pollMs:       number   // 默认 1500
  autoContinue: boolean  // 默认 true（用户确认后自动续跑 opencode）
}
```

---

## 5. 浏览器半区设计

### 5.1 槽位注册

```ts
ctx.slots.inject(['slots', 'locale'], (scope) => {
  scope.slots.register({
    name: 'conversation.view',
    id: 'ub-workflow',
    order: 300,
    label: () => i18n('概览工作流'),   // 或直接 'UB 工作流'
    locale: NS,
    inject: () => ({ api: ... }),
  }, WorkflowFlowView)
})
```

组件 props 使用 `ConvViewProps`（from `@deepseek-ai/dsh-client-ui-conversation/client`），
仅消费 `sessionId`；其余数据走 1s 轮询的 `/api/ub-workflow/state`。

### 5.2 视觉设计

- 触发方式（v0.1.1）：
  - 在会话输入框输入 `/ub-workflow <需求描述>`（可带 `--module` / `--mode` /
    `--stage design` / `--deploy` / `--change-id`）直接启动。
  - “UB 工作流” tab 只做监控与硬门禁确认，不再承载启动表单。
- 顶部工具条：
  - 左侧：view 标题 + 当前 change-id/模式徽章。
  - 右侧：活动 run 显示 “停止”。
- 步骤流程图（主区域）：
  - 横向布局：卡片等宽，按阶段链顺序排列；`develop` 为宽卡（内含子卡排）。
  - 卡片 = 序号圆点 + 标题 + 状态徽章 + 产物列表 + 时间 + note 一行。
  - 卡片之间由一条 SVG path 连接；颜色与目标状态联动。
  - `waiting_user` 卡片：高亮描边 + “需要用户接入” 图标 + 操作按钮
    （确认 / 取消运行）。
  - 空态：显示 `/ub-workflow` 斜杠命令用法引导。
- 状态徽章颜色约定：
  `pending` 灰、`running` 蓝（脉冲）、`waiting_user` 琥珀、`done` 绿、`failed` 红、`skipped` 中灰。

### 5.3 刷新与轮询

- `useWorkflowRun(sessionId)` hook：mount 后 `setInterval` 1500ms 拉取
  `/api/ub-workflow/state`，切换视图 tab / 卸载后清理。
- 轮询端点是轻量摘要（当前 run id + 步骤状态数组），单次响应 < 10KB。
- 页面 hidden 时暂停轮询（`document.visibilitychange`）。

---

## 6. 持久化与数据安全

| 数据 | 位置 | 说明 |
|---|---|---|
| run 记录 | `<repo>/.dsh-ub-workflow/runs.json` | 只存状态/元数据，不存大日志 |
| 日志尾巴 | 内存 last 80 lines，不落盘 | 通过 state API 下发最近 30 行 |
| opencode 会话 | opencode 自身存储 | 插件不解析个人数据 |
| loopback | 所有 API 仅回环 | 防止 LAN 暴露时被远程控制 |

---

## 7. 关键兼容性决策

1. **不替代 ub-leader**：插件只做启动、观测、门禁确认，不重写路由与 dispatch 决策。
2. **产物是最终真相**：UI 状态机不会单凭 opencode 事件进入 done；
   只有 ArtifactWatcher 确认产物存在才 done。
3. **容错优先**：opencode 事件解析失败只影响 note 文案，不影响步骤推进；
   进程崩溃 -> 当前步骤 failed；产物残留 -> 按文件存在性处理为幂等。
4. **只设计流程终点即 end**：`--stage design` 完成 `design-gate` 后 run 置 done。
5. **full 模式无 --deploy 时按 dev 链跑**（与仓库参数语义一致）。

---

## 8. 包结构与文件清单

```
dsh-ub-workflow/
├── DESIGN.md
├── README.md
├── package.json                # dsh bundle/client inject 声明，依赖参考 dsh-safeguard
├── tsconfig.json
├── tsconfig.build.json
├── tsdown.config.ts
├── cordis.patch.yml            # 可选，默认配置
├── vitest.config.ts
├── src/
│   ├── index.ts                # 宿主半区入口：store/engine/routes/settings 装配
│   ├── runner.ts               # OpenCodeRunner：spawn + 解析
│   ├── artifact-watcher.ts     # 产物轮询
│   ├── routes.ts               # loopback 路由
│   ├── store.ts                # WorkflowStore
│   ├── engine.ts               # WorkflowEngine
│   ├── types.ts                # 宿主/核心共享类型
│   ├── core/
│   │   ├── stages.ts
│   │   ├── stateMachine.ts
│   │   ├── artifacts.ts
│   │   └── opencodeEvents.ts
│   └── client/
│       ├── index.ts            # 浏览器半区入口 + 槽位注册
│       ├── api.ts              # loopback 客户端
│       ├── WorkflowFlowView.tsx
│       ├── StepCard.tsx
│       ├── FlowConnector.tsx
│       ├── RunLaunchForm.tsx
│       ├── useWorkflowRun.ts
│       ├── locales.ts
│       ├── slots-augment.ts
│       └── workflow-flow.module.css
├── tests/
│   ├── stateMachine.test.ts
│   ├── artifacts.test.ts
│   └── opencodeEvents.test.ts
└── build/                      # tsdown 客户端预设（vendor 自 dsh-web，仿 dsh-safeguard）
```

---

## 9. 验证方案

### 9.1 单元测试（vitest）

- `stateMachine.test.ts`：四种 mode 的阶段链生成、推进/回退/门禁、develop 子步骤聚合。
- `artifacts.test.ts`：临时目录写入产物后，验证步骤完成判定与幂等。
- `opencodeEvents.test.ts`：常见/畸形事件行解析，保证不 throw、提取 note/sessionId。

### 9.2 插件集成验证

1. `pnpm typecheck && pnpm test && pnpm build` 通过。
2. 将 `dsh-ub-workflow` link 进 desktop profile bundles，重启 DSH Desktop。
3. 打开一个会话 → 选择 “UB 工作流” tab → 填需求 → 启动。
4. 断点观察：步骤卡片随 `ub-workspace/changes/<change-id>/` 产物递增推进；
   等待用户步骤高亮并出现操作按钮。
5. 异常路径：在 repo 路径错误时启动 -> run failed；无会话时视图空态正常。

---

## 10. 后续迭代方向

- 将 `opencode serve` 作为执行后端，经由 HTTP 全双工接入，彻底解决非交互续跑
  的局限（question 应答、permission 审批可实时推送）。
- 步骤卡附带可展开的 change workspace 文件清单与关键 artifact 预览。
- 多 run 看板：按 change-id 归档历史，支持回放任一 run 的步骤快照。
- 与 DSH 待办（todo_write）打通，将 ub-leader 创建的计划同步为 DSH todo。