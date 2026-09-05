# dsh-ub-workflow 设计说明

## 1. 产品目标与范围

本插件把 [`ub_sdk/ub-drv-develop`](https://gitcode.com/ub_sdk/ub-drv-develop) 的执行进度放进原 DSH 会话页，让开发者看到当前任务、阶段、门禁、运行信号、失败原因和历史记录。

当前执行范围是 **Explore 只读探索**。这不是文档层面的约定：浏览器启动表单固定提交 `mode=explore`，Connection RPC 与斜杠命令独立校验，engine 在取得 lease 或持久化前再次拒绝非 Explore 意图，状态恢复也不会收养旧的活跃开发、设计或部署流程。

上游设计、动态参数、UT 和部署协议需要运行时 question 与权限交接。DSH 尚未提供可审计的原位问题/权限代理，因此这些阶段虽保留在内部类型、还原器和防御性测试中，却不属于当前可启动的产品能力。

协议审查基线为 `ub-drv-develop` commit `fb7fd03dabc6aa25536df759d78acf956875111d`；OpenCode 接口固定验证 1.18.3。

## 2. DSH 原位嵌入

`src/client/index.ts` 只向 DSH 的 list slot `conversation.view` 注册 id 为 `ub-workflow` 的视图：

```text
conversation page
├── DSH session header
├── DSH view tabs
│   ├── chat / trajectory / ...
│   └── UB 工作流          conversation.view contribution
├── DSH scroll container
│   └── WorkflowFlowView   plugin content
└── DSH composer
```

生产代码没有 HTML entry、页面 router 或独立 WebApp。`preview/` 是本地开发 fixture，用生产 React 组件模拟 DSH 壳层；`package.json#files` 不包含它。

视图根节点使用 `width: 100%`、`min-width: 0` 和 `container-type: inline-size`。布局断点按 DSH 正文容器宽度触发，阶段链只滚动插件自己的横向 viewport，不改变会话页滚动位置。

## 3. 运行时分层

```text
Browser half
  WorkflowFlowView / StepCard / RunLaunchForm
  createUbWorkflowClient(sessionId)
                 │ DSH Connection RPC
                 ▼
Host half
  rpc.ts                 input + ownership validation
  WorkflowStore          validated state + atomic persistence
  WorkflowEngine         Explore lifecycle + workspace lease
  OpenCodeServerRunner   process + REST/SSE supervision
                 │ Basic Auth, 127.0.0.1
                 ▼
OpenCode 1.18.3 → dedicated Explore leader / frozen references / selected source roots
```

宿主 channel `/ub-workflow` 使用 DSH Connection 的 `authority: loopback`。浏览器半区没有文件系统访问，也不使用页面相对 `fetch`。

## 4. Explore 状态机

公开阶段链只有两个阶段：

| 阶段 | 状态来源 | 继续条件 |
|---|---|---|
| `routing-plan` | 宿主生成的模块、change-id、工作流包、workspace 与 manifest→物理源码映射 | 开发者确认；映射未漂移且 workspace 仍为空、安全 |
| `explore` | OpenCode 活动、进程退出、稳定笔记回执与源码基线 | 正常退出；两节有效笔记通过 host 校验并绑定 size/SHA-256；没有越界文件；源码未变化 |

启动顺序：

1. `createRun` 分别校验 `workflowPath`、`workspacePath` 与 `sourcePath`，严格读取 module manifest，把每个便携 `code_root` 解析为物理目录，再取得 workspace 的独占租约。
2. run 进入 `waiting_user`；此时不会启动 OpenCode，也不会读取项目源码。
3. 路由卡把完整工作流包、workspace 和每条源码映射显示给开发者。确认时重新解析 manifest 并与冻结映射逐项比较，然后检查 change workspace 新鲜度、计算所选源码根指纹并建立本次 workspace。
4. 宿主复制并冻结受信 agent、skill、reference 和模块 manifest，重写最小 Explore leader，生成受限 OpenCode 配置。
5. runner 启动带高熵 Basic Auth 的 `127.0.0.1` OpenCode 服务，完成版本、OpenAPI、SSE、agent、skill 与最终权限探针后才提交 prompt。
6. SSE 提供运行活动与 session 状态；UI 只把它们当作实时信号，不凭日志文字认定成功。
7. SSE 若错过 `busy → idle` 窗口，会用有界 `/session/{id}/message` 恢复检查；只有完整的 assistant message 才能补成 idle，错误 message 直接失败。
8. OpenCode 正常退出后，engine 才重新计算源码指纹并审计 workspace，再稳定读取最终 UTF-8 笔记。笔记必须含有实质内容的 `## Domain Exploration` 与 `## Code Structure`，并说明文本检索/codegraph 边界；成功状态记录 size 和 SHA-256。事件或笔记提前出现不会把 Explore 标成完成。

所有异步 gate、exit 与 fingerprint 回调都复核 run 对象、revision、owner 和完整 lease。停止或删除发生在异步读取期间时，旧回调不能复活 run 或启动新进程。

## 5. 工作流包、workspace 与源码边界

三个路径承担不同职责：

- `workflowPath` 是宿主按只读输入使用的工作流包，只提供 agent、skill、reference 和 `references/<module>/_manifest.yaml`；
- `workspacePath` 保存 `ub-workspace` 状态、lease 和本次 `exploration_notes.md`；
- `sourcePath` 是便携 manifest 路径的默认解析根。`sourceRootOverrides` 可以把单个 manifest 路径指向另一个 Git 仓库中的绝对目录。

run 在持久化前保存 `workflowPath` 与规范化的 `{ manifestPath, path }[]`。路由确认、runtime 创建和 OpenCode 权限探针都复核这份映射；未知 override、重复物理目录、相对路径、遍历、保留目录、符号链接和 manifest 漂移均失败关闭。终态旧历史可以没有这些字段，活跃记录不能缺少。

## 6. 源码只读保证

Explore 在确认门禁与进程退出时各计算一次 `dsh-source-fingerprint-v3`：

- 每个物理源码根先定位所属 Git 顶层；一个运行可以组合多个独立仓库，只枚举 manifest 选中的根；
- 哈希仓库/根身份、原始 index `mode + object id + stage + path`、每个 tracked 工作区文件的稳定字节，以及根内未忽略的 untracked 文件；不单独加入 HEAD，所选根外变化不会导致误失败；
- 只执行参数固定的 `git rev-parse --show-toplevel` 与 `GIT_LITERAL_PATHSPECS=1 git ls-files`，不调用 `git diff`，因此不会触发仓库控制的 textconv、clean 或 process filter；
- Git 子进程没有 shell，使用最小环境，禁用 system config、pager、fsmonitor、hooks 和可选锁；
- 拒绝冲突 index、symlink、gitlink/submodule、特殊 mode、重复/不安全路径、数量或内容超限；
- 文件读取使用 `O_NOFOLLOW`、同一 fd 的前后 `fstat`、祖先目录复核、16,384 文件/256 MiB 总预算和 12 秒全局 deadline。

被 Git 忽略的未跟踪文件与仓库外路径不在该指纹保证内。运行时访问策略因此还必须独立限制模型能读取的目录。

## 7. OpenCode 运行边界

每个 run 使用不可变临时运行快照：

- 复制 allowlist 中的 agent、skill、reference 和模块 manifest，便于清单与来源 receipt 验证；总文件数、深度与字节数都有上限；
- 复制前后复核普通文件和祖先目录身份，拒绝 symlink、稀疏超限文件与读取期间变化；
- agent 的原始 YAML frontmatter 被移除，再写入最小 `name`、`description`、`mode` 与 `hidden` 字段，避免上游 permission 在 OpenCode 深合并时恢复；`ub-leader` 正文也由宿主替换为只允许既定 Explore 的专用指令，消除上游路由/开发/部署提示冲突；
- 每个源文件记录 path、size 与 SHA-256，runner 启动前重新验证 receipt 和快照 digest；
- 生成配置拒绝 shell、task、question、skill 和 permission escalation，其他 agent 不能被 task 调用；真实 OpenCode 1.18.3 的 `/agent` 与 `/skill` 返回值用于检查加载清单和最终权限。

生成的运行时 guard 还执行路径级限制：

- `read`、`glob`、`grep`、`list` 只能访问明确的冻结 reference 或物理源码根；skill 文件不在模型可读范围，仓库根目录搜索被拒绝；
- 不能读取 `.git`、`.env`、工作流状态或其他 change workspace；
- 只允许写当前 change 的 `exploration_notes.md`；源码编辑及其他文件创建被拒绝；
- 模型工具子进程的服务认证和 XDG 认证环境变量被移除。

OpenCode 本身仍从同一 OS 用户已有的 data 目录读取认证。临时 HOME、XDG config/state/cache 隔离普通用户配置与项目配置；插件不会复制认证文件。同一 OS 用户及其 OpenCode data 目录属于当前信任边界。

runner 由 supervisor 持有进程树。DSH stdin 关闭、stop、失败或超时会先 TERM，随后 KILL 整个 worker process group；SSE 主动中止被当作正常关闭路径并消费异步取消结果。

## 8. 状态、并发与恢复

状态位于 `<workspacePath>/ub-workspace/.dsh-ub-workflow/runs.json`：

- 持久化结构有 schema、长度、enum、时间戳和 canonical 阶段形状校验；日志尾部只存内存；
- state 文件与 owner 文件通过稳定普通文件读取，拒绝 symlink 与读取期间身份变化；
- 写入使用带 owner 的跨进程目录锁、0600 独占 staging 文件和原子 rename；
- 并发 store 合并不同 run，同 run revision 冲突会拒绝覆盖；
- 删除通过一次 `deleteAndPersist` 事务完成，persist 失败时恢复 run 以及 dirty/revision 元数据；
- 启动恢复不会把没有活租约的 `running` 或 `waiting_user` 记录继续显示为活动执行。

workspace 租约为 v2 owner tuple：`runId + changeId + pid + processIdentity + hostInstanceId + random token`。每次特权动作都复核磁盘中的完整 tuple；PID 被复用、token 改变或 owner 损坏时不会继续。死亡进程的完整旧 lease 会被确定性 tombstone 回收，不完整 lease 失败关闭。

## 9. 会话归属

斜杠命令使用当前 command agent id，内嵌表单使用 `conversation.view` props 的 `sessionId`。RPC 在 state、history、preview、gate、stop 和 delete 上核对同一个字符串，使正常 DSH UI 只显示本会话发起的运行。

这个 `sessionId` 是调用方提供的逻辑分区键，不是认证令牌。它不能防止同一受信本地调用方伪造另一个 id。调用载体的物理边界由 DSH Connection `loopback` authority、Desktop IPC 和同 OS 用户信任模型提供。

workspace 租约独立于会话：另一个会话在正常 UI 中看不到详情，但也不能在同一状态工作区并行启动第二个 workflow。

## 10. UI 设计

- mission panel 展示任务摘要、总体进度、当前阶段、完成数和耗时；动态状态通过 `aria-live` 报告。
- pipeline 使用两张阶段卡与信号连接线；当前卡自动居中，焦点和滚动限定在插件容器。
- 路由门禁用结构化列表完整显示 workflow bundle、workspace，以及每个 manifest→物理源码映射；超长路径只在卡片内部横向滚动，不截断审阅值。
- 状态色为 pending 灰、running 青、waiting 琥珀、done 绿、failed 红。
- 轨道、脉冲和信号包表达活跃状态；`prefers-reduced-motion` 会关闭这些动画。
- 正文与状态文字至少 11–12px，停止、确认、取消和删除等主要操作至少 44px 高/宽。
- 历史详情在当前 Tab 内展开，优先显示最深失败步骤。删除采用二次点击确认，并在 RPC 未完成时锁定按钮。

## 11. 验收边界

仓库内验证命令：

```sh
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

本地 `preview:ui` 用生产组件检查 DSH 壳层中的 planning、running、idle、失败详情、完整源码映射、窄正文与 reduced-motion。它只能证明 UI 布局与交互，没有替代真实宿主。

发布前仍需在完整 DSH Desktop 中安装 bundle，确认 `conversation.view` 的实际 props/销毁行为，并用可用的 OpenCode 账号完成一条最小 Explore。开发、设计、UT 和部署在实现可审计的问题/权限代理并完成新的协议验收前继续保持拒绝。
