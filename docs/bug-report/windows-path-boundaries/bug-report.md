# Windows 路径规则导致权限边界漂移

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | Windows 路径分隔符、盘符和大小写与 POSIX 不同，字符串前缀检查可能误放行相邻目录或误拒绝合法源码根 |
| 根因 | 权限匹配与 manifest 校验曾依赖平台默认字符串比较，没有统一 canonical path 语义 |
| 诊断策略 | 用混合分隔符、不同盘符大小写、`..`、保留根和相邻前缀逐项验证 manifest、permission 与 guard |
| 超时策略 | 路径规范化为本地同步检查，不增加外部等待 |
| 预警策略 | Windows permission pattern、case folding 与 win32 absolute/traversal 回归 |
| 用户交互修正 | Windows 默认部署路径能正确显示并执行；异常映射在路由前给出明确错误 |

## Bug report

1. **报告人**：跨平台边界审查发现。
2. **复现步骤**：使用 `D:\\Repo\\Src`、不同大小写和反斜杠路径匹配 OpenCode permission，并尝试 manifest 中的盘符/遍历路径。
3. **根因分析**：POSIX `isAbsolute`、分隔符和大小写假设不能直接代表 Windows 文件身份。
4. **修复方案**：manifest 同时检查 win32 absolute/drive，拒绝反斜杠便携路径；OpenCode permission path 独立规范化，Windows 采用不区分大小写语义；物理目录使用 realpath 校验。
5. **验证方式**：moduleManifest 与 serverRunner 权限匹配回归覆盖 Windows 形式，完整 201 项测试通过。
