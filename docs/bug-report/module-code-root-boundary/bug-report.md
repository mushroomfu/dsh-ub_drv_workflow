# Explore 跨模块源码读取

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | 选择 `udma` 运行 Explore 时，OpenCode 仍可能读取另一个模块源码；真实 UMMU 跨仓库源码又无法用同一根目录表达 |
| 证据 | 修复前回归显示 OpenCode `read` 的通配规则是 `allow`，运行时 guard 也会解析并放行跨模块路径 |
| 根因 | `_manifest.yaml` 的 `code_roots` 只用于测试耗时估算，没有形成 manifest→物理目录的 engine → runner 冻结契约 |
| 诊断策略 | 逐层追踪 manifest 解析、engine 调用、runner runtime、OpenCode 最终权限和 plugin path guard |
| 超时策略 | manifest 使用稳定、有界的同步读取；真实 OpenCode 契约探针受测试超时约束并在结束时清理服务进程 |
| 预警策略 | 保留 manifest 目录安全、跨模块源码、跨模块 reference 和 OpenCode 最终权限回归 |
| 用户交互修正 | manifest 缺少合法模块或源码根时在启动前失败关闭，不产生看似正常的 Explore 运行 |
| 验收 | 完整回归 24 个测试文件、201 项测试通过，包括跨仓库映射与真实 OpenCode 1.18.3 契约探针 |

## Bug report

1. **报告人**：独立代码终审发现，主代理按权限数据流补写失败测试并复现。
2. **复现步骤**：为 `udma` 配置一个选中源码根并创建另一个模块目录，启动 runner 后检查最终 agent 权限；再把 UMMU 两个根放进独立 Git 仓库。修复前通配读取被允许，且单 repo 配置不能正确解析 UMMU。
3. **根因分析**：manifest loader 只解析测试 timing；`WorkflowEngine` 没有冻结便携根到物理目录的映射，runtime 只能构造仓库级 allowlist。
4. **修复方案**：稳定读取并严格校验根级 `module` 与 `code_roots`；从独立 `sourcePath` 或精确 override 解析真实目录；run 冻结映射并在 gate/runtime 重验；OpenCode 与 guard 默认 deny，只开放所选根、当前笔记和所选资料。
5. **验证方式**：覆盖 block/inline manifest、遍历、保留目录、重复根、symlink、未知 override、跨仓库源码/reference 与映射漂移；真实 OpenCode `/agent` 探针确认最终权限没有重新放宽。
