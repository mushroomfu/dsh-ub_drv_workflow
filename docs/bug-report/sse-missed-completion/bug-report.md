# SSE 重连错过完成窗口

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | prompt 已被接受，但 SSE 重连错过 root session 的 `busy → idle`，已完成运行可能永久等待 |
| 根因 | runner 只依据实时 status event 收尾，没有从持久化 message 状态恢复 |
| 诊断策略 | 在 status 列表省略目标 session，并让 message endpoint 返回完成 assistant message 或 error message |
| 超时策略 | 恢复读取使用同一有界 HTTP body、请求 deadline 和三次 SSE 重连预算 |
| 预警策略 | 保留“漏事件可恢复”“未完成 message 不成功”“error message 失败”的回归 |
| 用户交互修正 | 短暂断流后能恢复真实完成；无法证明完成时仍失败关闭 |

## Bug report

1. **报告人**：运行器断线恢复审查发现。
2. **复现步骤**：prompt 接受后断开 SSE，使重连发生在 idle event 之后；状态接口不再列出 session，但 message 历史已有完整 assistant 回复。
3. **根因分析**：仅监听瞬时事件，缺少 OpenCode 已持久化消息的恢复判据。
4. **修复方案**：若 status map 中缺少目标 session，读取 `/session/{id}/message?limit=128`；只有完成 assistant message 可合成 idle，error message 立即失败。
5. **验证方式**：serverRunner 定向测试模拟缺失 status、完成 message 和错误 message；OpenAPI 必需路径同时固定该 endpoint。
