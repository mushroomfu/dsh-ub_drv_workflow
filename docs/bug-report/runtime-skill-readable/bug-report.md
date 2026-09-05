# 禁用 skill 工具后仍可直接读取 skill 文件

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | `skill` 工具为 deny，但冻结 `skills/` 仍在 read 与 runtime guard allowlist 中 |
| 根因 | 快照清单校验需要 skill 文件，被误等同为模型执行时也需要读取它们 |
| 诊断策略 | 同时检查 OpenCode permission map 与 guard hook，避免只有一层拒绝 |
| 超时策略 | 无新增运行时等待 |
| 预警策略 | permission 与 guard 测试都要求读取 skill 文件失败，reference 读取仍成功 |
| 用户交互修正 | Explore 不会重新吸收开发/部署 skill 指令，阶段行为更可预测 |

## Bug report

1. **报告人**：主代理在 dedicated leader 收尾审查中发现。
2. **复现步骤**：取得冻结 config 目录，直接用 read 工具读取 `skills/ub-workflow/SKILL.md`；修复前 permission 和 guard 均放行。
3. **根因分析**：快照完整性范围和模型可读范围共用了同一目录集合。
4. **修复方案**：继续冻结 skill 供 `/skill` 清单与 receipt 校验，但从模型 read 规则和 guard 的 `SNAPSHOT_ROOTS` 中移除。
5. **验证方式**：先加入两条失败测试复现，再修改双层 allowlist；serverRunner 15 项定向回归通过。
