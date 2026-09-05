# Workspace 文件可绕过路由确认门禁

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | 路由卡把 `.knowledge/events.ndjson` 显示为产物；轮询看到该文件时可把 `routing-plan` 标成 done，而不经过用户确认 |
| 根因 | 旧完整开发流程把事件流存在当作路由证据，Explore 复用了同一 artifact hint；路由门禁没有声明为 host-verified |
| 诊断策略 | 对 waiting route 直接注入 workspace 文件，并在纯 reducer 与 engine 轮询边界检查状态 |
| 超时策略 | 无新增等待；门禁只由同步 RPC mutation 推进 |
| 预警策略 | stages 要求 route 没有 artifact hint，artifact/workflow event 均不能完成 host-verified route |
| 用户交互修正 | 路由卡不再显示误导性的事件文件；只有开发者点击“确认”才能启动源码读取 |

## Bug report

1. **报告人**：主代理在浏览器等待态视觉检查中发现。
2. **复现步骤**：创建 waiting Explore，在其 change workspace 写入 `.knowledge/events.ndjson` 后触发 reconcile；旧 artifact reducer 会把 route 标 done。
3. **根因分析**：`ARTIFACT_HINTS['routing-plan']` 继承旧协议，且 routing 没有进入宿主验证步骤集合。
4. **修复方案**：清空 routing artifact hints，并把 `routing-plan` 加入 `HOST_VERIFIED_STEPS`，使 artifact 与 workflow event 都不能替代 gate RPC。
5. **验证方式**：stages、artifacts、workflowEvents 共 36 项定向测试通过；等待态预览只显示完整读取映射和确认按钮。
