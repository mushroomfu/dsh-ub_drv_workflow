# 发布包携带过期 lib

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | 源码和测试已更新，但 `npm pack --dry-run` 仍会直接收录较早构建的 `lib`，安装后运行旧逻辑 |
| 根因 | package 发布 `lib`，而打包检查本身不会保证产物晚于源码 |
| 诊断策略 | 比较源码/产物时间并在 bundle 中搜索 dedicated leader、`sourceRootOverrides` 等关键标记 |
| 超时策略 | clean build 使用项目现有构建 deadline，不在 pack 阶段隐式联网 |
| 预警策略 | 最终门禁先 clean build，再检查 bundle 标记、声明文件和 pack 清单 |
| 用户交互修正 | 用户安装的 tarball 与本轮审查通过的源码保持一致 |

## Bug report

1. **报告人**：独立终审发现并定为发布态 P0。
2. **复现步骤**：源码修改后不执行 build，直接运行 `npm pack --dry-run --ignore-scripts`；清单包含旧时间的 `lib/index.js`，且搜不到新配置/leader 文案。
3. **根因分析**：测试由 TS 源码运行，发布入口却是缓存的 JS bundle，二者缺少最终一致性检查。
4. **修复方案**：源码与文档冻结后执行 `build/clean.mjs` 驱动的 clean build，并对最终 `lib` 做关键标记检查后再 pack。
5. **验证方式**：质量门禁记录 clean build、bundle 搜索、package entry 数和 `preview/`/旧 route 排除结果。
