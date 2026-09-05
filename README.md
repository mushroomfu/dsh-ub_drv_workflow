# dsh-ub-workflow

`dsh-ub-workflow` 是面向 [`ub_sdk/ub-drv-develop`](https://gitcode.com/ub_sdk/ub-drv-develop) 的 DSH 桌面插件。它把只读代码探索的进度、阶段、门禁、日志和历史结果放进现有 DSH 会话页。

生产端只向 DSH 的 `conversation.view` 槽位注册 `ub-workflow`。会话标题、视图 Tab、正文滚动区和输入框仍由 DSH 壳层提供；本包没有 HTML 入口、页面路由或独立 WebApp。仓库中的 `preview/` 只用于本地仿宿主视觉检查，并由发布清单排除。

## 当前发布范围

当前可靠发布范围仅开放 **Explore 只读探索**：

1. 开发者在当前会话提交模块与探索目标。
2. 插件创建可审阅的路由计划，但不会立刻读取源码。
3. 开发者确认后，宿主冻结上游 agent、skill、reference 和模块 manifest，并计算源码基线。
4. OpenCode 1.18.3 在受限配置下读取明确的源码目录，只能写本次 change workspace 的 `exploration_notes.md`。
5. 进程正常退出后，宿主重新计算源码指纹、校验 workspace，并稳定读取最终笔记；源码被改动、出现越界文件、缺少两个必需章节或正文不足都会失败关闭，成功状态记录笔记 size 与 SHA-256。

`dev`、`--stage design`、`full --deploy` 的阶段结构只用于显示历史记录和纯状态兼容；启动表单、RPC、斜杠命令、engine 与活跃状态恢复都会拒绝执行它们。上游设计、动态参数、UT 和部署流程包含运行时 question 与权限交接；在 DSH 提供可审计的原位问题/权限代理前，不把这些路径描述为可用能力。

## 会话内嵌结构

```text
DSH 会话页
├── 会话标题 / Tab / 滚动区 / 输入框                  DSH 所有
└── conversation.view: ub-workflow                   插件注册
    └── WorkflowFlowView
        ├── 当前任务与总体进度
        ├── 路由确认门禁
        ├── 两阶段 Explore 航线与实时遥测
        └── 可展开、可二次确认删除的历史记录

DSH host
├── /ub-workflow Connection RPC（authority: loopback）
├── WorkflowStore + workspace lease
├── WorkflowEngine
└── OpenCodeServerRunner
    └── authenticated 127.0.0.1 REST/SSE server
```

浏览器半区不直接访问文件系统，也不按页面 URL 拼接 HTTP API。所有操作通过 DSH Connection RPC 进入宿主半区。

## 使用

1. 安装依赖并构建：

   ```sh
   pnpm install
   pnpm build
   ```

2. 将本包加入 DSH Desktop profile 的 bundles；`cordis.patch.yml` 提供宿主插件行。

3. 在 DSH 设置中分别配置工作流包、状态工作区和源码树；如果 manifest 的便携路径分布在不同 Git 仓库，再为对应 `code_roots` 填绝对路径覆盖。也可配置 OpenCode 可执行路径。

4. 在原会话输入框启动：

   ```text
   /ub-workflow --mode explore --module udma 梳理 jetty 资源回收的调用链和异常路径
   ```

   也可以打开同一会话的“UB 工作流”Tab，使用内嵌表单。

5. 在“路由与流程计划”卡片逐项确认工作流包、workspace，以及每个 manifest 路径到物理源码目录的映射。确认后才启动 OpenCode。

可用参数：

| 参数 | 说明 |
|---|---|
| `--mode explore` | 必填的公开模式；其他模式会被明确拒绝 |
| `--module ubase\|cdma\|udma\|ummu\|ubus` | 必填；冻结对应模块 manifest |
| `--change-id <slug>` | 可选；省略时生成含 run 唯一后缀的安全 id |

## 宿主配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 禁用时停止轮询和当前运行，并拒绝写操作 |
| `workflowPath` | `D:\ai_work\ai_workspace\ub-drv-develop\ub-drv-develop` | 只提供 agent、skill、reference 和模块 manifest 的工作流包 checkout |
| `workspacePath` | `D:\ai_work\ai_workspace` | 保存 `ub-workspace` 状态、lease 与 Explore 笔记的可写根目录 |
| `sourcePath` | `D:\ai_work\ai_workspace` | 未单独覆盖时，用来解析 manifest 便携 `code_roots` 的源码树根目录 |
| `sourceRootOverrides` | `{}` | `manifest code_root → 物理绝对目录`；用于 UMMU 这类跨 Git 仓库源码 |
| `opencodeBin` | 空 | 空时按环境变量、常用安装位置和 `PATH` 查找 |
| `pollMs` | `1500` | 轮询周期，归一化到 250–60000 ms |

例如 UMMU manifest 声明 `libummu/` 与 `drivers/iommu/hisilicon/`，而两个目录属于不同仓库时，可以配置：

```json
{
  "workflowPath": "D:\\ai_work\\ai_workspace\\ub-drv-develop\\ub-drv-develop",
  "workspacePath": "D:\\ai_work\\ai_workspace",
  "sourcePath": "D:\\ai_work\\ai_workspace",
  "sourceRootOverrides": {
    "libummu": "D:\\src\\libummu",
    "drivers/iommu/hisilicon": "D:\\src\\kernel\\drivers\\iommu\\hisilicon"
  }
}
```

覆盖键必须与所选模块 manifest 规范化后的 `code_roots` 完全一致；未知键、重复键、相对路径、符号链接叶节点和不存在的目录都会在创建运行前被拒绝。映射在运行中冻结，设置或 manifest 后续漂移不会静默改变读取范围。

## Connection RPC

逻辑 channel 是 `/ub-workflow`，endpoint 包括：

| endpoint | 作用 |
|---|---|
| `state` / `runs` / `run` | 读取当前逻辑会话的状态和历史 |
| `launch` | 校验 Explore 输入、取得 workspace 租约并生成待确认路由 |
| `gate` | 确认或取消路由门禁 |
| `preview` | 有界读取门禁对应的普通文本产物和证据 id |
| `stop` / `delete` | 停止当前运行，或事务性删除终态历史 |

每次调用都携带 DSH 提供的 `sessionId`，RPC 用它进行显示过滤和操作归属校验。`sessionId` 是调用方提供的逻辑分区键，不是身份认证或跨恶意本地调用方的安全边界；物理调用边界由 DSH Connection 的 `loopback` authority 与宿主运行环境提供。

## 可靠性边界

- OpenCode 固定验证版本为 1.18.3。启动前检查 health、OpenAPI 必需路径、SSE、冻结 agent/skill 清单，以及 `ub-leader` 的最终权限配置。
- 上游运行时文件按 run 复制到只读临时快照；真正执行的 `ub-leader` 正文由宿主替换为最小 Explore 指令，其他 agent 隐藏且禁止 task 调用，skill 工具和 skill 文件读取均被拒绝。源文件在快照后变化会使启动失败。
- 模型没有 shell 权限。运行时插件把 `read/glob/grep/list` 限制到冻结的源码映射和所选模块资料，只允许编辑本次 `exploration_notes.md`；权限请求会失败关闭。
- `dsh-source-fingerprint-v3` 只覆盖所选源码根，可组合多个独立 Git 仓库。它哈希仓库与根路径、原始 index mode/object/stage/path、tracked 工作区字节，以及未忽略的 untracked 文件；不单独哈希 HEAD，因此所选根之外的提交或文件变化不会误伤当前 Explore。
- 指纹实现只调用参数固定的 `rev-parse --show-toplevel` 和 literal-pathspec `ls-files`，不调用 `git diff`，不会触发仓库配置的 textconv、clean 或 process filter。
- 指纹拒绝冲突索引、符号链接、子模块、特殊文件模式、路径置换、超限输入和读取期间变化。被 Git 忽略的未跟踪文件及仓库外路径不在指纹保证内。
- 每个 workspace 同一时间只允许一个运行。租约绑定 host instance、PID 启动身份和随机 token；状态使用跨进程锁、稳定文件读取、独占临时文件与原子 rename。
- UI 中的“完成”要求正常进程退出、稳定 UTF-8 笔记、两个有实质内容的必需章节、允许的 workspace 文件集合和未变化的源码基线共同成立。成功卡片绑定笔记 size/SHA-256；日志或事件文字本身不会推进状态。
- OpenCode 认证数据仍由同一 OS 用户的既有 OpenCode data 目录读取；临时 HOME、config、state 和 cache 隔离项目/用户配置，模型工具子进程不会继承认证环境变量。同一 OS 用户是当前信任边界。
- 完整 DSH 宿主和真实模型调用不在此工作区内。自动化与仿宿主预览证明插件边界和交互，最终仍需在真实 DSH 中做一次会话级 smoke test。

## 开发验证

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm preview:ui
```

`preview:ui` 复用生产 React 组件，模拟 DSH 的侧栏、会话标题、Tab、滚动正文和输入框。它只展示 Explore 的 planning、running、idle 与历史状态，不会进入发布包。

详细设计与审查记录见 [DESIGN.md](./DESIGN.md)、[可靠性审查](./docs/reviews/2026-09-04-reliability-review.md) 和 [质量门禁报告](./docs/reviews/2026-09-05-quality-gate.md)。
