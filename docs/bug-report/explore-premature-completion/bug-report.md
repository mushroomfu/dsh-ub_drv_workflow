# Explore 提前显示完成

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | canonical event 或 `exploration_notes.md` 先出现时，Explore 卡片可能在 OpenCode 进程退出前变成 done |
| 根因 | 通用 evidence reducer 把“产物已出现”当成阶段完成，而 Explore 还需要宿主侧退出与源码不变性审计 |
| 诊断策略 | 分别注入文件证据、workflow event 和 exit callback，观察每个边界的状态转移 |
| 超时策略 | 保持 runner/指纹既有 deadline；未收到可验证退出时不推断成功 |
| 预警策略 | 保留“事件先到仍 running”和“正常退出后四项审计才 done”的回归 |
| 用户交互修正 | UI 不再提前给出绿色完成状态，失败原因落在 Explore 卡片和历史详情 |

## Bug report

1. **报告人**：主代理在完成语义复核中发现。
2. **复现步骤**：运行 Explore，在子进程尚活跃时写入合法笔记并投递完成事件；修复前 evidence reducer 可把步骤推进为 done。
3. **根因分析**：Explore 沿用了文件/事件可独立完成阶段的通用规则，没有声明为 host-verified step。
4. **修复方案**：把 Explore 加入 `HOST_VERIFIED_STEPS`；artifact/event 只保留证据和运行信号，最终状态仅由 exit handler 在正常退出、非空笔记、workspace allowlist 与源码指纹一致后写入。
5. **验证方式**：artifacts、workflowEvents 和 engine 回归覆盖退出前、成功退出与失败退出。
