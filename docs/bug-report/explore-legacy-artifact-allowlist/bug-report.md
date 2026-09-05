# Explore 仍放行旧知识流程产物

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | 合法笔记旁再写 `.knowledge/retrieved.json`，旧 exit allowlist 仍会把 Explore 判成功 |
| 根因 | Explore 已收窄为专用只读执行器，但 workspace allowlist 继续保留完整 harness 的两个知识文件 |
| 诊断策略 | 在正常退出路径分别加入 patch、主流程文件和单个旧知识文件，观察最终 host 审计 |
| 超时策略 | 无新增等待，沿用已有有界目录审计 |
| 预警策略 | engine 回归要求任意第二项 workspace 产物都失败，唯一允许文件是笔记 |
| 用户交互修正 | “只产 exploration_notes.md”与实际成功条件一致，不再隐藏后台遗留文件 |

## Bug report

1. **报告人**：主代理在发布范围一致性审查中发现。
2. **复现步骤**：写入有效结构笔记与 `.knowledge/retrieved.json`，让 OpenCode code 0 退出；修复前 workspace 审计允许两者并完成 run。
3. **根因分析**：`allowedExploreFiles` 仍继承旧知识获取流程，而 dedicated leader 和 prompt 已明确禁止该流程。
4. **修复方案**：Explore exit allowlist 只保留 `exploration_notes.md`；任何目录、链接、空文件或第二项文件都失败关闭。
5. **验证方式**：新增 legacy knowledge artifact + 正常退出回归，engine 27 项测试通过。
