# 上游 leader 指令与只读权限冲突

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | 冻结后的上游 `ub-leader` 仍要求重新路由并调用 question、task、skill、bash 或部署流程，但运行时将这些工具拒绝 |
| 根因 | 只清洗了 agent frontmatter 权限，没有清洗与本插件 Explore 范围冲突的正文 |
| 诊断策略 | 检查最终快照中的 leader 正文和 `/agent` 有效权限，而非只看生成配置 |
| 超时策略 | leader 重写发生在有界快照阶段，不增加模型或网络等待 |
| 预警策略 | 快照测试断言冲突语句消失、最小 Explore 指令存在，真实 OpenCode 探针校验有效权限 |
| 用户交互修正 | 运行现场只显示既定两阶段 Explore，不会因内部重新路由陷入无意义等待 |

## Bug report

1. **报告人**：最小权限与系统提示联合审查发现。
2. **复现步骤**：冻结原始上游 leader，启动只读 Explore；正文要求调用被拒工具，模型会反复失败或无法产出笔记。
3. **根因分析**：权限被收窄，语义指令却仍是完整开发 harness，两者没有同一可信来源。
4. **修复方案**：宿主重建 `ub-leader` 正文，只允许读取明确源码根和冻结 reference、写唯一笔记并退出；其他 agent hidden 且 task deny。
5. **验证方式**：runtimeSnapshot/serverRunner 测试检查最终正文、权限和真实 OpenCode 1.18.3 agent 加载。
