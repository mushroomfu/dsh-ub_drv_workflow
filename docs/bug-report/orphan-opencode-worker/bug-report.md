# OpenCode worker 可能成为孤儿进程

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | 停止 DSH 或 runner 后，只杀启动包装进程可能留下 OpenCode worker/孙进程 |
| 根因 | 包装器 PID 不是最终服务 PID，原实现没有稳定的进程树所有权与升级终止 |
| 诊断策略 | 让 worker 派生忽略 TERM 的孙进程，关闭 supervisor stdin 后检查整个进程组 |
| 超时策略 | 先 TERM，短 grace 后 KILL；worker PID 通过 fd 3 报告，等待都有上限 |
| 预警策略 | POSIX supervisor 回归检查 TERM-resistant 进程组最终消失 |
| 用户交互修正 | 点击停止、禁用插件或退出 DSH 后不会继续显示幽灵运行或长期占用端口 |

## Bug report

1. **报告人**：进程生命周期审查发现。
2. **复现步骤**：OpenCode 包装进程再派生 worker/孙进程，让孙进程忽略 TERM，然后只终止最外层进程；旧实现可能遗留后台进程。
3. **根因分析**：没有 supervisor 持有真实 worker PID 和整棵进程组，stop 只针对单 PID。
4. **修复方案**：增加 supervisor、fd 3 worker 身份通道和 process-group TERM→KILL；stdin 关闭、超时、SSE 失败与用户停止走同一关闭路径。
5. **验证方式**：serverRunner 的 POSIX supervisor 测试实际创建抗 TERM 孙进程并验证清理。
