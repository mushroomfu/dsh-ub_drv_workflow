# dsh-ub-workflow

DSH 桌面插件：把 `ub-drv-develop` 仓库的 UnifiedBus 内核驱动 AI 开发工作流
（ub-leader：需求 → 设计 → 编码 → 测试 → 审查 → 交付归档，含硬门禁）接到
DSH 主界面，以 “步骤卡片 + 状态连线” 的方式实时展示每个阶段的进展、状态、
是否需要用户接入。

## 功能

- 在会话视图环新增 **“UB 工作流”** 标签页（`conversation.view` 槽位）。
- 每个工作流步骤一张卡片：
  - 步骤名、状态徽章（待启动 / 进行中 / 等待用户 / 已完成 / 失败 / 跳过）
  - “需要用户接入” 标记、产物清单、时间与最近进展
- 卡片之间以 SVG/分隔线连接，连线颜色随下游状态变化。
- 从会话对话框输入 `/ub-workflow <需求>` 直接触发工作流，无需跳转页面。
- “UB 工作流” 标签页只负责实时监控与硬门禁确认。
- 硬门禁卡（流程计划 / 设计门禁 / 部署验证）等待用户确认或取消。
- 宿主半区通过 loopback HTTP 提供状态与操作；所有路由仅回环可访问。

## 架构

```
src/core/           纯逻辑：阶段链、状态机、产物规则、opencode 事件解析
src/index.ts        宿主半区：store + engine + loopback 路由 + 设置
src/runner.ts       spawn `opencode run --format json` 并解析事件
src/artifact-watcher.ts  轮询 ub-workspace/changes/<change-id> 产物
src/client/         浏览器半区：槽位注册 + 步骤卡片视图
```

## 使用

1. 在本包目录执行 `pnpm install && pnpm build`（或 `pnpm build`）。
2. 将包加入 desktop profile 的 `dsh.profile.bundles` 并执行
   `link:` 依赖（本仓库已内置 `cordis.patch.yml`，会插入宿主插件行）。
3. 重启 DSH Desktop，在会话输入框输入：

   ```
   /ub-workflow 帮 UDMA 模块新增 jetty 资源回收接口，支持异常场景资源释放
   ```

   可选参数直接写在需求前：`--module`、`--mode`、`--stage design`、
   `--deploy`、`--change-id`。

4. 点击 “UB 工作流” tab 即可查看每个步骤的实时进展，并在硬门禁卡上确认或取消。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ub-workflow/state` | 当前活跃 run 摘要 |
| GET | `/api/ub-workflow/runs` | 历史 run 列表 |
| GET | `/api/ub-workflow/run?run=<id>` | run 详情 |
| POST | `/api/ub-workflow/run` | 创建并启动 run |
| POST | `/api/ub-workflow/gate` | 确认/取消硬门禁 |
| POST | `/api/ub-workflow/stop` | 停止 run |
| POST | `/api/ub-workflow/delete` | 删除历史 run |

## 参数语义

| 表单字段 | 对应 ub-leader 参数 |
|---|---|
| 模块 | `--module`（留空 = 自动识别） |
| mode dev/full/explore | `--mode` |
| 只设计 | `--stage design` |
| 部署到 EVB | `--deploy`（full 模式） |
| change-id | `--change-id`（留空自动生成） |

## 开发

```sh
pnpm typecheck
pnpm test        # vitest（核心状态机/产物规则/事件解析）
pnpm build       # tsc 声明 + tsdown（node 半区 lib/ + 浏览器闭包 lib/client.js）
```

## 说明

- 插件不重写 ub-leader 的编排决策；它只负责启动 opencode、按产物推进视图、
  并在硬门禁处传递用户决定。产物到达是步骤完成的唯一硬依据。
- `opencode run` 单次是非交互的；用户确认后以后台会话续跑方式实现
  （`--session` + `--continue`），首版标记为 best-effort。