# 任意非空笔记可造成 Explore 假成功

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | OpenCode 写入 `x\n` 并正常退出，旧 exit 审计会把整个 Explore 标成 done |
| 根因 | workspace audit 的 `kind=file` 只证明 size > 0，没有稳定读取内容，也没有执行 dedicated leader 与 prompt 声明的笔记契约 |
| 诊断策略 | 用占位文件、合法结构、空文件、删除文件和异常退出分别驱动真实 exit handler |
| 超时策略 | 笔记最多稳定读取 1 MiB；读取复用 no-follow、前后身份与目录 witness 检查 |
| 预警策略 | 保留“一字节 + exit 0 失败”“合法两节 + exit 0 成功并记录 SHA-256”的回归 |
| 用户交互修正 | 绿色完成状态绑定到可审查的确切笔记字节，错误卡明确说明缺少章节、正文或检索范围声明 |

## Bug report

1. **报告人**：独立终审发现并定为 P1。
2. **复现步骤**：完成路由门禁，在 change workspace 只写入 `exploration_notes.md`，内容为一个字符，让 runner 以 code 0、无 signal 退出；修复前状态为 done。
3. **根因分析**：`auditChangeEntries` 只保存类型和 size，engine 看到非空普通文件后未读取/哈希/验证内容就完成阶段。
4. **修复方案**：通过稳定 fd 读取最终 UTF-8 笔记，核对 audit size；要求 `## Domain Exploration`、`## Code Structure` 各有实质正文，并声明文本检索与 codegraph 限制；成功 note 持久化 size 与完整 SHA-256。
5. **验证方式**：engine 新增占位文件失败和合法笔记哈希回执测试；artifact watcher、engine 定向回归与完整回归通过。
