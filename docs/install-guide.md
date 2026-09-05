# DSH Desktop 安装与配置指南

适用于 dsh-ub-workflow v0.1.0（main `66e4b4e`，tag `v0.1.0`）。

## 1. 前置条件

- DSH Desktop（cordis 插件运行时，Electron 43 / Chrome 150）
- 已认证的 **OpenCode 1.18.3**（插件按其 git worktree 相对路径求值权限；其他版本未经兼容性验证）
- 插件包：npm 包 `dsh-ub-workflow@0.1.0`，或源码仓库构建产物（`pnpm install && pnpm build`）

## 2. 装入 profile

在目标 profile 的 `package.json` 中把本包加入 bundles：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-ub-workflow"]
    }
  }
}
```

- npm 安装：`pnpm add dsh-ub-workflow`（或把 tarball 放进 profile 后 `pnpm add ./dsh-ub-workflow-0.1.0.tgz`）
- 本地开发：在 profile 的 `node_modules` 里做符号链接指向仓库目录（`pnpm build` 即生效，重启宿主加载）

## 3. 配置宿主插件行

编辑 profile 的 `cordis.patch.yml`（不是 `cordis.yml`），为 `ui-ub-workflow` 行提供 config：

```yaml
- id: ui-ub-workflow
  config:
    enabled: true
    workflowPath: /path/to/ub-drv-develop        # 工作流包仓库（含 module manifests）
    workspacePath: /path/to/workspace            # 可写工作区根目录（change workspace 在其下创建）
    sourcePath: /path/to/kernel_proxy            # 只读源码映射根
    sourceRootOverrides: {}                      # 可选：覆盖 manifest 声明的源码根映射
    opencodeBin: /opt/homebrew/bin/opencode      # 可选：空时按环境变量/常用位置/PATH 查找
    pollMs: 1500                                 # 可选：运行状态轮询间隔
```

### 三类路径的边界（务必理解）

| 路径 | 读写性 | 用途 |
|---|---|---|
| `workflowPath` | 只读 | 工作流包仓库，从中读取模块 manifest（声明各模块的 code root id） |
| `workspacePath` | 可写 | 每次运行在其下创建独立 change workspace，**这是唯一可写位置** |
| `sourcePath` | 只读 | 被探索的源码树，经 `sourceRootOverrides` 映射到 manifest 声明的根 |

启动时会冻结源码基线指纹；运行中源码发生漂移会被拒绝继续（只读证明）。

## 4. 启动与验证

```bash
node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js --profile <profile名>
```

打开 `http://127.0.0.1:3080/`，进入任意会话，应看到 **「UB 工作流」** 会话视图页签：

- 顶栏状态胶囊显示「宿主链路在线」即插件 RPC 正常
- 空态显示启动表单与斜杠命令提示 `/ub-workflow --mode explore --module udma <探索目标>`
- 跑一次最小 Explore：填探索目标 + 选模块提交 → 生成路由计划（硬门禁）→ 确认后执行 → 产出 `exploration_notes.md`

## 5. 已知边界（预期行为，非故障）

- 仅开放 **Explore 只读模式**；dev / design / deploy 显示为未开放
- 同一会话同时只允许一个进行中的运行；运行记录按会话隔离
- 视觉验收注意：CSS 双写前缀属性时未前缀版必须写在最后（lightningcss 去重坑，见 `docs/bug-report/css-prefix-minify-order`）

## 6. 卸载

从 `dsh.profile.bundles` 移除 `dsh-ub-workflow` 并删除 `cordis.patch.yml` 中对应行，重启宿主即可；运行记录存于 workspacePath 下，可手动清理。
