# Patch move 目标无法可靠收窄

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | 即使 edit 只允许笔记，patch/apply_patch 的 move/delete 语义仍可能改写源码或把文件移动到允许范围外 |
| 根因 | OpenCode 权限匹配面向工具调用，不能可靠从所有 patch 方言中提取并约束每个目标路径 |
| 诊断策略 | 构造 `*** Move to:` 与不同 patch 工具名，验证权限层和 runtime guard |
| 超时策略 | 调用前同步拒绝，不解析大 patch 文本 |
| 预警策略 | `apply_patch`、`apply-patch`、`patch` 全部保持 deny 回归 |
| 用户交互修正 | Explore 的唯一可写结果仍是 `exploration_notes.md`，不会因为 patch 语法产生隐式源码修改 |

## Bug report

1. **报告人**：写入边界审查发现。
2. **复现步骤**：让模型调用 patch 工具，把允许目录内路径 move 到源码目录；只校验首个输入路径的实现可能漏掉目标路径。
3. **根因分析**：patch 是复合操作，OpenCode 通用 permission 无法给所有内部路径提供与 edit 相同的精确保证。
4. **修复方案**：Explore 对三种 patch 工具名统一失败关闭；只保留 edit/write，且 guard 要求目标严格等于当前 run 的笔记路径。
5. **验证方式**：serverRunner guard 测试包含 move patch 和别名拒绝，源码 edit/write 也分别验证。
