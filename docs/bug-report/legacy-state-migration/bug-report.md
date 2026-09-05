# 旧状态路径迁移丢失历史

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | 旧 `.dsh-ub-workflow/runs.json` 含 A/B，加载后首次写入新 `ub-workspace/.dsh-ub-workflow/runs.json` 只留下本轮 dirty 的 C |
| 证据 | 回归测试在修复前收到 `['current-c']`，期望 `['current-c', 'legacy-a', 'legacy-b']` |
| 根因 | `loadRepo()` 可从 legacy 路径加载，`persist()` 的 merge 基线却只读取 current 路径；正常 v2 终态旧记录不进入 `dirty` |
| 诊断策略 | 逆向追踪 load source、内存 dirty 集合、首次 persist merge source 与文件优先级 |
| 超时策略 | 纯同步本地状态测试，无外部等待；由 Vitest 默认超时约束 |
| 预警策略 | 保留多记录迁移回归，验证观察者从 current 路径重新加载后仍看到全部 id |
| 用户交互修正 | 无额外交互；迁移在首次合法持久化时原子完成 |
| 验收 | RED 稳定复现；修改 merge source 后 17 个 store 测试全部通过 |

## Bug report

1. **报告人**：独立代码复核发现，主代理按数据流与回归测试复现。
2. **复现步骤**：在旧路径写入两个合法 v2 终态 run，调用 `loadRepo()`，新增第三个 run 并 `persist()`。期望新文件包含三条；实际只包含新增记录。
3. **根因分析**：读取路径选择与写入 merge 基线不一致。旧记录虽在内存中，但因未修改而不在 `dirty`，所以不会被合并进空的新路径文件。
4. **修复方案**：`parseDiskRunsForMerge()` 在 current 文件不存在时，从经过真实目录和稳定文件校验的 legacy 文件取得第一次 merge 基线。current 一旦存在仍拥有优先级，且不安全 current 文件继续失败关闭。
5. **验证方式**：新增 `carries every legacy-path history record into the first current-path write`，先观察失败，再确认修复后通过；随后纳入完整测试。
