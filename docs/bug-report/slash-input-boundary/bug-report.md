# 斜杠命令绕过需求长度上限

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | RPC 拒绝超过 20,000 字符的 requirement，斜杠命令却直接调用 `createRun()` |
| 证据 | 修复前 direct-engine 回归预期抛错但实际成功创建 run |
| 根因 | `/ub-workflow` handler 与 engine 没有复用 `validateLaunchBody` 的持久化合约上限 |
| 诊断策略 | 对照 RPC、slash、engine 三条 launch 数据流，定位首次取得 lease 和首次 persist 前的校验点 |
| 超时策略 | 纯本地 handler/engine 测试，无外部等待 |
| 预警策略 | 保留 RPC 边界、direct-engine 与真实 command registration 三层回归 |
| 用户交互修正 | 超限命令返回明确的 20,000 字符错误，不创建运行记录 |
| 验收 | engine/input 35 项与 slash integration 1 项通过 |

## Bug report

1. **报告人**：独立代码复核发现，主代理复现并补齐三层测试。
2. **复现步骤**：用 `--mode explore --module udma` 加 20,001 字符目标调用 engine 或斜杠 handler。期望在 lease/persist 前拒绝；修复前 engine 会创建超出 store schema 的 run。
3. **根因分析**：长度限制只存在于 RPC body validator；斜杠 handler 解析后直达 engine，而 engine 信任调用方。
4. **修复方案**：抽出共享 `validateRequirement()`；engine 在任何 run 创建前执行。slash handler 进一步复用完整 `validateLaunchBody()`，并把 413 转为明确中文错误。
5. **验证方式**：RPC validator 覆盖 20,001 字符；direct-engine 测试确认 store 为空且 runner 未启动；command registration 集成测试确认没有生成状态文件。
