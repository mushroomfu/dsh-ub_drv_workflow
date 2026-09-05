# 非 Explore 运行绕过公开入口限制

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | RPC、斜杠命令和表单都只允许 Explore，但直接调用 engine 仍可创建 `dev`/design-only 运行，旧活跃记录也可能进入 lease 收养流程 |
| 证据 | 修复前 5 个回归分别观察到 dev 创建成功、篡改后的 launch/tick/segment 继续推进，以及旧 dev/design 状态未按 Explore-only 原因失败 |
| 根因 | 支持范围在各 adapter 重复判断，核心只拒绝 `full/deploy`；store 的恢复谓词也只覆盖部署和动态 question |
| 诊断策略 | 从全部启动入口向内追踪 create、lease、persist、launch、gate、tick、segment、event、exit 与 loadRepo 恢复路径 |
| 超时策略 | 纯本地 engine/store 回归，无外部等待；由 Vitest 默认超时限制 |
| 预警策略 | 共享一个 production support predicate，并保留入口、核心篡改、segment 与历史恢复四层测试 |
| 用户交互修正 | 所有非 Explore 意图返回同一明确原因；历史终态仍可查看，活跃旧流程显示失败且不能恢复执行 |
| 验收 | 新增失败测试先稳定复现；engine/store/input/command 四组 48 项全部通过 |

## Bug report

1. **报告人**：独立代码终审发现，主代理沿核心执行与恢复链复现。
2. **复现步骤**：绕开 RPC 直接调用 `createRun({ mode: 'dev' })`，或先创建合法 Explore 再把内存状态改成 dev/design-only 并调用 launch、tick 或 segment；另从状态文件加载活跃 dev/design-only 记录。修复前这些路径没有统一失败关闭。
3. **根因分析**：Explore-only 是 adapter 层策略，没有成为 engine/store 共同不变量；多个内部边界仍沿用旧的“只禁 full/deploy”条件。
4. **修复方案**：新增 `isSupportedWorkflowIntent()`；input validator、engine 与 store 共用。engine 在 claim/persist 前和每个执行边界复核；store 在 adopt lease 前复核，并避免覆盖另一个健康 host 的状态。
5. **验证方式**：验证 dev、design-only、deploy 的直接创建不产生记录或 lease；验证被篡改 run 在 launch/gate/tick/segment 关闭；验证旧活跃 dev/design-only 加载后失败；四层定向回归通过。
