# 窄容器隐藏连接状态可访问名称

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | DSH 正文小于 680px 时，连接状态文本被 CSS 隐藏，只剩 `aria-hidden` 圆点，无障碍树中的状态节点为空 |
| 根因 | 响应式样式只考虑视觉压缩，组件没有给连接状态独立的可访问名称和 live status 语义 |
| 诊断策略 | 检查窄容器规则与静态 DOM，无需依赖 jsdom 计算 container query |
| 超时策略 | 无运行时等待 |
| 预警策略 | 组件回归要求 online 和 syncing 两种状态都有随数据变化的 `aria-label` |
| 用户交互修正 | 视觉仍保留紧凑状态点，屏幕阅读器可读并可感知“宿主链路在线/正在同步”变化 |

## Bug report

1. **报告人**：独立 UI 终审发现并定为 P3。
2. **复现步骤**：把插件 slot 缩到 680px 以下；CSS 将 `.connection > span:last-child` 设为 `display:none`，剩余圆点带 `aria-hidden=true`。
3. **根因分析**：状态容器没有 `aria-label`/sr-only 内容，隐藏可见文字后节点没有可访问名称。
4. **修复方案**：连接容器增加随 snapshot/error 变化的 `aria-label`、`role=status` 与 polite live region，窄布局样式保持不变。
5. **验证方式**：WorkflowFlowView 回归覆盖在线与同步两种标签；宽窄浏览器视觉检查确认没有新增可见占位。
