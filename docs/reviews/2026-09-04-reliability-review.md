# dsh-ub-workflow 可靠性审查

日期：2026-09-05
项目基线：`e042627109903496a136679bbdae2627c336e5b3`
协议参照：[`ub_sdk/ub-drv-develop`](https://gitcode.com/ub_sdk/ub-drv-develop) `fb7fd03dabc6aa25536df759d78acf956875111d`
OpenCode 契约：1.18.3

## 结论

基线代码不适合直接作为可信进度源，也没有满足“嵌入原 DSH 页面”的产品要求。它曾把报告文件存在视为成功，进程、状态、路径和会话还存在竞态或越界风险。

修订后的生产 UI 只注册 `conversation.view`，不再提供独立页面。当前可启动能力收窄为带源码不变性校验的 Explore；表单、斜杠命令、RPC、engine 和状态恢复都拒绝设计、开发和部署。这个范围内的状态由用户路由门禁、受控 OpenCode 进程、结构化笔记回执、workspace allowlist 和前后源码指纹共同决定。

代码可以进入真实 DSH + OpenCode 的 Explore 集成验证。完整 DSH 应用与真实模型调用不在本工作区，所以尚不能标记为生产验收完成；设计、开发、UT 和部署也不属于当前可用能力。

## 主要发现与处理

| 编号 | 严重度 | 发现与影响 | 当前处理 |
|---|---|---|---|
| R-01 | 高 | 独立 HTTP 页面会脱离 DSH 会话生命周期，并造成“已嵌入”的假象 | 删除生产 routes；只注册 `conversation.view`，所有交互改走 DSH Connection RPC |
| R-02 | 高 | 报告文件即使描述失败也会存在，不能单独证明阶段成功 | Explore 只在进程正常退出、结构化笔记回执有效、workspace allowlist 通过且源码指纹一致时完成 |
| R-03 | 高 | 把插件 run id 当作 OpenCode session id 会导致首次启动失败或续接错误 | 通过 REST 创建真实 `ses_…`，SSE 先连接；所有后续事件只接受本 runner 拥有的 root/child session |
| R-04 | 高 | 旧进程的延迟 close/stdout 可能污染新运行 | runner 与 engine 同时检查 run、process identity、generation 和当前 server 对象；失效回调直接丢弃 |
| R-05 | 高 | 路径检查后再按路径读取存在 symlink/替换窗口 | 源码、runtime、artifact、事件、owner/state 使用 `O_NOFOLLOW`、同 fd 前后 `fstat` 与祖先复核 |
| R-06 | 高 | 状态直接写入会在中断时损坏；删除先改内存后失败会留下潜伏删除 | store lock + 独占 staging + 原子 rename；`deleteAndPersist` 失败时恢复 run、dirty 与 revision 元数据 |
| R-07 | 高 | 只核对 PID 或部分 lease 字段会被 PID 复用、旧 owner 或并发实例误认 | v2 lease 绑定 PID 启动身份、host instance、run/change 与 256-bit token；每个特权动作复核完整 tuple |
| R-08 | 严重 | `git diff` 可触发仓库控制的 textconv、clean/process filter，在“只读指纹”阶段执行命令 | 指纹仅用固定参数的 `rev-parse --show-toplevel`/literal `ls-files`，无 shell；随后由宿主逐个稳定读取并哈希源码文件 |
| R-09 | 高 | 同步读取大源码可能阻塞 DSH host，Git 子进程退出异常也可能无限等待 | 源码指纹改为异步分块读取；文件数、单/总字节、Git 输出、子进程与全局 deadline 均有上限 |
| R-10 | 高 | 运行中直接引用可变的上游 agent/skill 会产生不可复现行为和 TOCTOU | 每个 run 创建 allowlist 快照，记录 source receipt 与 digest；源文件变化、symlink、稀疏超限或身份变化即拒绝 |
| R-11 | 严重 | OpenCode 深合并 agent frontmatter 时，上游 permission 可能保留并覆盖收窄配置 | 移除原 frontmatter，重建最小 agent metadata；用真实 OpenCode 1.18.3 `/agent` 探针检查最终权限 |
| R-12 | 高 | 服务认证或 XDG 认证环境若传给模型工具子进程，会扩大凭据暴露面 | Explore 拒绝 bash/task/question；runtime guard 的 `shell.env` 删除认证变量；不复制认证文件 |
| R-13 | 高 | 对仓库根执行 read/glob/grep 可能暴露 `.git`、状态和其他 change | guard 拒绝根级搜索、`.git`、`.env`、状态目录与其他 change，只开放冻结 manifest 指向的源码目录 |
| R-14 | 严重 | 上游设计、UT、部署需要运行时 question/权限代理；仅靠视觉门禁不能形成可信边界 | 执行范围收窄为 Explore，dev/design/full/deploy 在表单、命令、RPC、engine 和恢复层均失败关闭 |
| R-15 | 中 | 把调用方传入的 `sessionId` 描述为安全认证会高估隔离强度 | 明确其用途只是正常 UI 的逻辑过滤与归属；物理边界依赖 DSH loopback/IPC 和同 OS 用户信任 |
| R-16 | 中 | 较早轮询或异步 fingerprint 回调可能在 stop/delete/新会话后覆盖新状态 | 浏览器请求使用单调 generation；engine 异步返回前复核对象、revision、owner、状态和 lease |
| R-17 | 中 | 历史记录单击删除容易误触，RPC 失败又可能重复触发 | 删除改为二次点击确认；pending 时禁用操作；宿主删除事务失败保持记录可见 |
| R-18 | 中 | 8–10px 正文与 28–36px 操作控件在 DSH 窄正文中难读、难点 | 操作性文字提升到 11–12px，停止、门禁与删除控件提升到至少 44px；装饰标签保留小号排版 |
| R-19 | 高 | UI 选择模块但 runner 没有落实 manifest 的 `code_roots`，Explore 仍可能跨模块读取 | 严格解析并冻结 manifest→物理目录映射；OpenCode 与 guard 默认拒绝，只开放选中源码根、资料和当前笔记 |
| R-20 | 高 | 需求 20,000 字符上限只在 RPC，斜杠命令和直接 engine 调用可绕过并生成无法可靠持久化的 run | 抽出共享校验，在 engine 首次 lease/persist 前执行；命令注册与 RPC 复用同一 validator |
| R-21 | 高 | legacy 状态可加载，但首次写入 current 路径时只合并 dirty run，未修改历史会丢失 | current 不存在时以经过稳定校验的 legacy 文件作为首次 merge 基线，之后 current 始终优先 |
| R-22 | 严重 | 入口只允许 Explore，但直接 engine 调用和活跃旧状态仍可能创建、收养或推进 dev/design | 共享 production support predicate；claim/persist 前及 launch/gate/tick/segment/event/exit/recovery 边界全部复核 |
| R-23 | 严重 | 把工作流包、可写状态目录和源码 checkout 当成同一个 repo，会让真实 UMMU 的 `libummu` 与内核目录无法正确定位，也可能审查错代码 | 配置拆成 `workflowPath`、`workspacePath`、`sourcePath` 与精确 overrides；run 持久化并复核完整源码映射，支持多个独立 Git 仓库 |
| R-24 | 严重 | canonical event 或笔记在子进程退出前就能把 Explore 标成 done，UI 会提前报告成功 | Explore 成为宿主验证步骤；事件只提供活动证据，必须等正常退出、非空笔记、workspace 审计和退出指纹全部通过才完成 |
| R-25 | 高 | SSE 重连恰好错过 `busy → idle` 时，实际完成的会话会一直挂起或错误失败 | prompt 接受后若状态表没有 session，读取有界 message 历史；只接受完整 assistant message，error message 失败关闭 |
| R-26 | 高 | 冻结的上游 `ub-leader` 正文仍要求路由、skill、question 或开发动作，与 Explore 最小权限互相冲突 | 宿主重写 dedicated Explore leader 正文，明确只读工具、精确源码根和唯一笔记；其他 agent 隐藏且 task deny |
| R-27 | 高 | `skill` 工具虽被拒绝，但模型仍可直接 read 冻结 skill 文件，重新引入与最小 Explore 冲突的流程指令 | skill 仍保留在受信快照供清单核验，但从 OpenCode read allowlist 和 runtime guard 搜索根移除 |
| R-28 | 严重 | 发布包直接包含 `lib`，若最后一次源码修改后未 clean build，tarball 会运行旧实现而测试只覆盖新源码 | `build/clean.mjs` 在编译前删除旧输出；最终质量门禁检查 bundle 关键标记与 `npm pack` 清单 |
| R-29 | 高 | 任意非空 `exploration_notes.md` 加正常退出即可成功，一字节占位文件也会显示绿色完成 | 稳定读取最终 UTF-8 笔记并绑定 size/SHA-256；两个必需章节、实质正文和文本检索/codegraph 范围声明均由宿主校验 |
| R-30 | 低 | 窄 DSH 容器隐藏连接文字后只剩 `aria-hidden` 圆点，屏幕阅读器无法得知在线/同步状态 | 连接容器增加动态 `aria-label`、status role 和 polite live region；视觉仍保持紧凑圆点 |
| R-31 | 严重 | `.knowledge/events.ndjson` 曾能作为 routing artifact 把路由步骤标 done，绕过“确认后才读源码”的用户门禁 | routing 不再声明文件产物并成为 host-verified step；artifact 和 workflow event 都不能替代 gate RPC |
| R-32 | 高 | Explore exit allowlist 仍接受旧知识流程文件，和“唯一产物是笔记”的 UI/权限契约不一致 | 最终 workspace 只允许 `exploration_notes.md`；任意第二项文件、目录、链接或空文件均失败关闭 |

## DSH 嵌入审查

- `src/client/index.ts` 只向官方 `conversation.view` list slot 注册 `ub-workflow`。
- DSH 壳层继续拥有会话标题、Tab、滚动容器和 composer；插件只渲染 Tab 内容。
- 浏览器端没有页面相对 API，也不直接读文件；host 端在 `/ub-workflow` 上提供 loopback Connection RPC。
- `preview/` 复用生产组件模拟宿主布局，但被 `package.json#files` 排除。
- 根容器的 `min-width: 0` 与 container query 能响应 DSH 正文宽度；阶段自动定位只滚动自身 viewport。
- 历史详情在当前 Tab 内展开；删除采用二次确认，不导航到其他页面。

因此，当前嵌入结构符合用户要求。真实 DSH 的 slot props、主题继承与销毁行为仍需安装后的 smoke test 才能最终确认。

## Explore 可信状态模型

路由确认前，run 展示冻结后的模块、change-id、workflow bundle、workspace、每条 manifest→物理源码映射和阶段链。确认时必须满足：

- 当前 run 仍由相同 session 和 workspace lease 拥有；
- 工作流 manifest 当前解析结果与 run 中冻结的物理映射逐项一致；
- change workspace 不存在或完全为空，且所有祖先都是普通目录；
- 每个源码根属于可读取的 Git 仓库，所选根内 index、tracked/untracked 路径安全；
- 源码基线能在总 deadline 内完成；
- 上游 runtime 文件可稳定复制并通过 digest/receipt 验证；快照 manifest 的 `module` 与便携 `code_roots` 合法且和冻结映射一致。

OpenCode 运行结束后，成功需要同时满足：

- 子进程正常退出，SSE 生命周期没有安全失败；
- `exploration_notes.md` 是当前 workspace 内稳定、非空的普通文件；
- 笔记是有界 UTF-8，包含有实质内容的 `## Domain Exploration` 与 `## Code Structure`，并明确文本检索而非 codegraph 的覆盖边界；成功状态记录该文件的 size 与 SHA-256；
- workspace 中没有 allowlist 外文件、目录或链接；
- 退出时的源码指纹与门禁确认时完全一致。

事件和文件哈希提供完整性与一致性，不提供对同一 OS 用户的密码学真实性。同一用户若能同时篡改 OpenCode、插件状态和全部证据，仍在当前信任边界内。

## 会话与认证边界

RPC 的 `sessionId` 来自 command agent id 或 `conversation.view` props。它保证正常 DSH UI 的显示过滤与 mutation 归属一致，但不是无法伪造的认证令牌。

OpenCode 服务绑定 `127.0.0.1` 并使用每次生成的高熵 Basic Auth。运行进程使用临时 HOME、XDG config/state/cache，项目配置被关闭；既有 OpenCode data 目录仍负责账号认证。插件没有获得用户授权去复制本地凭据，因此不会把 `auth.json` 等认证文件搬入临时 runtime。

## 验证证据

最终自动化、构建、发布清单与浏览器检查结果记录在 [2026-09-05-quality-gate.md](./2026-09-05-quality-gate.md)。其中包含真实 OpenCode 1.18.3 的启动、agent 与 skill 契约探针，不会提交模型 prompt。

## 集成前剩余事项

1. 在实际 DSH Desktop 中安装构建产物，配置真实 `workflowPath`、`workspacePath`、`sourcePath`/`sourceRootOverrides` 和 OpenCode 可执行文件。
2. 核对 `conversation.view` 的宽/窄布局、会话切换、隐藏恢复和卸载清理。
3. 用可用账号跑一条最小 Explore，确认实际源码目录读取、`exploration_notes.md` 生成、停止和历史回看。
4. 在 DSH 提供可审计的原位 question/permission 代理前，继续拒绝 design、dev、UT 和 deploy。
