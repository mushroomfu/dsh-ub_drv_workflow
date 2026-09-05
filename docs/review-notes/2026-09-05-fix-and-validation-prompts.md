# Follow-up prompts

## 修复提示词

```text
请审查并修复 dsh-ub-workflow，基线为当前分支最新提交。生产前端必须继续嵌入 DSH 原会话页的 conversation.view，不得新增生产 HTML、独立路由或第二套页面壳。当前公开执行范围只有只读 Explore；dev、design、full、UT、deploy 及 question/permission escalation 必须失败关闭，除非 DSH 已提供可审计的原位代理并补齐对应协议与测试。

开始前阅读 README.md、DESIGN.md、docs/reviews/2026-09-04-reliability-review.md 和 docs/reviews/2026-09-05-quality-gate.md。优先检查：session/RPC 所有权、路由 gate 不可由文件或事件绕过、workflow/workspace/source 三类路径映射、跨 Git 源码指纹、运行时快照、OpenCode 最终权限顺序与路径守卫、进程树回收、SSE 丢失 idle 后的有界恢复、workspace 文件白名单，以及 exploration_notes.md 的稳定读取、章节内容、size/SHA-256 回执。

发现问题时先写能复现边界的回归测试，再做最小修复。完成后运行 pnpm exec vitest run --configLoader runner、pnpm typecheck、pnpm build、npm pack --dry-run --json --ignore-scripts 和 git diff --check。发布清单不得包含 preview/、HTML、src/、tests/ 或 routes 声明。报告精确测试数量、构建结果、包清单和仍需真实 DSH 验证的边界，不要把仿宿主预览描述成生产验收。
```

## 真实 DSH 验证提示词

```text
请在真实 DSH Desktop 中验收 dsh-ub-workflow 最新构建。把插件作为 bundle 安装到测试 profile，分别配置 workflowPath=<工作流包 checkout>、workspacePath=<可写状态目录>、sourcePath=<源码默认根>；若 manifest 的 code_roots 分布在多个 Git 仓库，按 manifestPath 配置 sourceRootOverrides。使用已认证的 OpenCode 1.18.3，同一 OS 用户执行，不复制认证文件。

在一个现有 DSH 会话中打开“UB 工作流”Tab，确认 DSH 仍拥有页面标题、Tab、滚动区和输入框，插件只占 conversation.view 内容区。用 /ub-workflow --mode explore --module <模块> <明确的只读探索目标> 启动：检查路由卡完整显示 workflow、workspace 和每条 manifest→物理源码映射；取消 gate 时不得启动 OpenCode；重新启动并确认 gate 后，检查阶段、耗时、在线状态、实时活动和当前卡片自动定位。

运行期间尝试从另一个会话读取、停止或删除该 run，应被 session 所有权拒绝；尝试 dev/design/full/deploy 应被拒绝。完成后确认只有 exploration_notes.md 被写入，笔记含有非占位的 Domain Exploration 与 Code Structure 两节，并明确文本检索/codegraph 边界；成功详情应显示笔记大小和 SHA-256。修改选中源码根后重复验证，应触发源码基线失败。最后在窄窗口检查状态仍有可访问名称、按钮至少 44px、动画在 reduced-motion 下停用，并保存 DSH 日志、截图和 run 状态作为验收证据。
```
