# 生产构建丢失 backdrop-filter（lightningcss 前缀去重）

## 诊断胶囊

| 项 | 记录 |
|---|---|
| 现象 | vite 预览中液态玻璃正常，但同一源码经 `pnpm build` 装入真实 DSH 宿主后，所有面板 `backdrop-filter` 计算值为 `none`，玻璃效果整体消失 |
| 根因 | `build/tsdown.client.ts` 内 lightningcss `minify: true` 会把 `backdrop-filter` 与 `-webkit-backdrop-filter` 视为同一属性去重，**只保留靠后的声明**；源码中 `-webkit-` 版写在后面，产物只剩前缀版，而 Chrome 150（DSH Desktop Electron 43 内核）已不识别 `-webkit-backdrop-filter` |
| 诊断策略 | 在真实宿主页面读取注入的 `<style>` 原文与 getComputedStyle 对比；用最小 CSS 用例单独喂给 lightningcss 复现去重方向 |
| 预警策略 | CSS 中成对写前缀/未前缀属性时，**未前缀标准属性必须放在最后**；视觉类改动除 vite 预览外必须在真实宿主复验计算值 |
| 用户交互修正 | 无（纯构建期问题，运行时无报错、无告警，只能肉眼或计算值发现） |

## Bug report

1. **报告人**：真实宿主安装复验时发现（vite 预览验证全绿之后）。
2. **复现步骤**：CSS 中按 `backdrop-filter` → `-webkit-backdrop-filter` 顺序书写，`pnpm build` 后把 `lib/client.js` 装入任意 DSH profile 启动宿主，读取面板计算样式：`backdrop-filter: none`；产物文本中只剩 `-webkit-backdrop-filter`。
3. **根因分析**：lightningcss minify 的前缀去重按声明顺序保留最后一个；Electron 43（Chrome 150）已移除 `-webkit-backdrop-filter` 别名，于是规则中该声明被浏览器丢弃，且无任何控制台报错。vite dev 预览不经过 lightningcss minify，因此预览无法暴露此问题。
4. **修复方案**：三个 CSS 模块（workflow-flow / step-card / run-launch-form）共 5 处全部改为 `-webkit-backdrop-filter` 在前、`backdrop-filter` 在后（提交 `68de61e`）。
5. **验证方式**：构建后 grep 产物确认未前缀版存在；真实宿主页面 getComputedStyle 读到 `blur(24px) saturate(1.45)` 等预期值；206 项测试与 typecheck 保持全绿。

## 长期注意事项

- **规则**：在 `src/client/*.module.css` 中，凡需要双写前缀的属性（backdrop-filter、user-select 等），未前缀标准属性永远写在最后一行。
- **规则**：视觉效果验收必须包含一次真实宿主（`pnpm build` + profile 安装）的计算值抽查，vite 预览不能替代——二者经过的 CSS 处理管线不同。
