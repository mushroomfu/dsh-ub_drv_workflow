# Quality Gate Report

检查时间：2026-09-05
实现分支：`codex/tech-ui-reliability`
基线提交：`e042627109903496a136679bbdae2627c336e5b3`
上游参考：`ub_sdk/ub-drv-develop@fb7fd03dabc6aa25536df759d78acf956875111d`

> 审查项目代码是否可靠，并让开发者在运行中直观看到进度和阶段。生产前端必须嵌入原有 DSH 会话页面，不能新增独立前端页面。

## 结论

当前实现满足“原 DSH 会话内嵌”要求：生产客户端只注册 `conversation.view`，由 DSH 提供标题、Tab、滚动容器和会话输入框。仓库中的 `preview/` 只是本地仿宿主测试夹具，不在发布包中；发布清单没有 HTML、独立路由或 `preview/` 文件。

当前可启动范围收敛为只读 Explore。`dev`、design、full、UT 和 deploy 保留为历史状态显示兼容，但入口、RPC、命令解析、engine 和恢复路径都会失败关闭。它们依赖 DSH 尚未提供的可审计原位提问与权限代理，因此不计入已交付能力。

## 愿景覆盖

| # | 原始要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | 在运行中直观看到进展和阶段 | 已覆盖 | 任务总览、两段 Explore 流程、当前阶段自动居中、门禁、实时信号、耗时和历史详情 |
| 2 | 审查并提高代码可靠性 | 已覆盖 | 精确 session、来源映射、源码指纹、运行时快照、受控进程树、状态租约、终态审计 |
| 3 | 页面更有科技感和灵动感 | 已覆盖 | 控制塔视觉、轨道与信号动效、状态色、容器响应式、窄屏重排和 reduced-motion |
| 4 | 嵌入原 DSH 页面，不新增生产页面 | 已覆盖 | 只注册 `conversation.view`；发布包无 HTML、前端 route 和预览壳 |

## 可靠性验收

| 边界 | 状态 | 主要证据 |
|---|---|---|
| DSH 原会话页嵌入 | 通过 | `src/client/index.ts` 只向 `conversation.view` 注入视图；bundle 中保留该注册 |
| 公开执行范围 | 通过 | 表单、RPC、斜杠命令、engine 与活跃恢复只接受 Explore，其他模式一致拒绝 |
| 路由确认 | 通过 | 路由只能由宿主 gate RPC 完成，日志、事件和 workspace 文件不能绕过确认 |
| 工作流包、workspace、源码分离 | 通过 | 三类路径分别配置；manifest 路径到物理源码根逐项展示、冻结并在 gate 时复核 |
| 源码只读证明 | 通过 | `dsh-source-fingerprint-v3` 只覆盖所选根，可组合多个 Git 仓库；拒绝 symlink、submodule、冲突索引和特殊模式 |
| OpenCode 运行边界 | 通过 | 最小 Explore leader、deny-first 权限、工具路径守卫、Basic Auth、隔离 HOME/config/state/cache、进程组清理 |
| 运行时完整性 | 通过 | 每次运行建立不可变快照并校验 receipt/digest；运行中工作流包漂移会失败 |
| 完成语义 | 通过 | 只在进程正常退出、源码指纹一致、workspace 审计和结构化笔记校验全部通过后完成 |
| 并发和恢复 | 通过 | workspace 租约绑定完整 owner tuple；状态文件原子写入；旧回调不能复活已停止或删除的运行 |
| SSE 断线 | 通过 | 有界 message 恢复只接受完整 assistant 结果，错误消息直接失败 |
| 响应式和无障碍 | 通过 | 639px DSH 正文宽度下验证 running、waiting、idle；在线状态保留 live region 与可访问名称 |
| 发布内容 | 通过 | clean build 后 dry-run 共 43 项，无 `preview/`、HTML、旧 routes 或源码测试夹具 |

## 最终验证

```text
pnpm exec vitest run --configLoader runner  → 24 files / 204 tests passed
pnpm typecheck                              → passed
pnpm build                                  → passed; clean host/client bundles
npm pack --dry-run --json --ignore-scripts  → 43 entries; preview/、HTML、routes excluded
bundle marker inspection                    → conversation.view、source-root mapping、note SHA、OpenCode guard present
browser fixture at 639px                    → running、waiting、idle rendered in a DSH-owned shell; accessibility tree checked
```

完整测试包含真实 OpenCode 1.18.3 本机契约探针，检查 agent/skill 清单及最终权限顺序；也包含状态恢复、路径边界、跨进程租约、运行时快照、内容审计和 React 交互测试。

## 验收边界

当前工作区不含完整 DSH Desktop，也没有执行带真实模型响应的端到端 Explore。因此，本报告证明插件自身的嵌入契约、构建产物、状态与权限边界，以及仿宿主交互；最终安装后仍需在真实 DSH 会话中使用已认证的 OpenCode 账号跑一次最小 Explore smoke test。
