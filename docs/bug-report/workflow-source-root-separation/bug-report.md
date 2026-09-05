# 工作流包与真实源码树混用

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | manifest、状态目录和被审查源码被假定在同一个 checkout；真实 UMMU 的两个源码根分属独立 Git 仓库时无法正确运行 |
| 根因 | 单一 `repoPath` 同时承担了工作流包、可写 workspace 和源码定位三种职责 |
| 诊断策略 | 追踪设置 → manifest loader → run 持久化 → engine prompt → runner 权限 → UI 门禁的完整路径 |
| 超时策略 | 源码根解析只做有界稳定 manifest 读取和目录身份检查；真正内容读取留到 12 秒指纹预算内 |
| 预警策略 | 保留工作流/状态/源码三树分离、跨仓库 UMMU override、映射漂移与未知 override 回归 |
| 用户交互修正 | 路由卡完整展示 workflow、workspace 和每条 manifest→物理路径，确认后才读取源码 |

## Bug report

1. **报告人**：代码审查发现，随后用真实 UMMU 目录布局验证。
2. **复现步骤**：让工作流包位于独立 checkout，把 `libummu` 与 `drivers/iommu/hisilicon` 放在两个 Git 仓库，再按旧单路径配置启动 Explore；旧实现会在错误根下解析或放宽读取范围。
3. **根因分析**：配置和 run 契约没有保存工作流来源与物理源码映射，manifest 的便携路径被错误地绑定到插件 checkout。
4. **修复方案**：拆分 `workflowPath`、`workspacePath`、`sourcePath` 和 `sourceRootOverrides`；创建 run 前严格解析并冻结映射，门禁和 runtime 再次逐项复核。
5. **验证方式**：moduleManifest、engine、index、serverRunner 覆盖独立树、跨仓库映射、未知/重复 override、manifest 漂移与权限；真实 UMMU 两根指纹探针约 156 ms 完成。
