# dsh-plugin-sandbox-escalation-fix

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 忽略不高于 Session 当前权限的无效 `sandbox_permissions` 请求，避免模型在已经拥有更高或相同权限时反复触发 `not strictly wider` 错误，同时保留 DSH 原有的提权审批和非法参数校验。

![DSH 重复请求同级沙箱权限](assets/teaser.png)

## 使用方法

插件安装到 profile 后，会在 Host 侧修复 `bash`、`pwsh`、`write` 和 `edit` 中多余或过时的提权参数。`standard`、`code`、`cordis`、`minimal` 以及自定义 preset 中可见的对应工具共用这一修复，不需要额外配置。

插件针对以下错误：

```text
Error: sandbox escalation to "danger-full-access" is not strictly wider than
this call's current "danger-full-access" mode
```

同样覆盖当前已经是 `danger-full-access`，但模型仍附加 `sandbox_permissions: "workspace-write"` 的过时请求：

![DSH 在 danger-full-access 下重复请求 workspace-write](assets/teaser_add.png)

对于确实需要升级的请求，如果模型遗漏 `justification`，或只提供空字符串和空白字符，插件会自动填入 `"Empty justification"`：

![DSH 缺少非空 justification](assets/teaser_justification.png)

反过来，如果模型只提供 `justification`，却没有提供 `sandbox_permissions`，插件会忽略这个没有实际作用的理由，避免触发下面的参数配对错误：

```text
Error: invalid escalation: justification is only valid together with sandbox_permissions
```

安装后，如果模型请求的权限不比 Session 当前权限更高，插件就忽略这个无效的提权请求，并使用当前 Session 权限正常执行工具。真正更宽的请求仍进入 DSH 审批流程；缺失或空白的理由会使用上述 fallback，合法的非空理由保持不变。`read-only`、未知 target 或非字符串 justification 等非法值仍由 DSH 拒绝。

插件只作为 bundle layer 安装到目标 profile，不修改 DSH 安装目录。

## 安装或更新

从 npm 安装固定版本到 Web profile：

```sh
dsh plugin --profile web add dsh-plugin-sandbox-escalation-fix@0.1.2
```

更新现有安装时使用同一条命令。安装完成后重启 `dsh web`，让 Host 加载新插件，然后新建会话。

安装最新版时可以省略版本号：

```sh
dsh plugin --profile web add dsh-plugin-sandbox-escalation-fix
```

开发本地版本时传入 checkout 路径：

```powershell
dsh plugin --profile web add C:\path\to\dsh-sandbox-escalation-fix
```

移除插件：

```sh
dsh plugin --profile web remove dsh-plugin-sandbox-escalation-fix
```

## 权限语义

| 当前 mode | 请求的 `sandbox_permissions` | 处理结果 |
| --- | --- | --- |
| `read-only` | `workspace-write` | 保持参数，继续走原有审批 |
| `read-only` | `danger-full-access` | 保持参数，继续走原有审批 |
| `workspace-write` | `workspace-write` | 删除冗余参数，按普通调用执行 |
| `workspace-write` | `danger-full-access` | 保持参数，继续走原有审批 |
| `danger-full-access` | `danger-full-access` | 删除冗余参数，按普通调用执行 |
| `danger-full-access` | `workspace-write` | 删除过时参数，按普通调用执行 |
| 任意 mode | 未提供，只有 `justification` | 删除无效理由，按普通调用执行 |

`approval: never` 表示审批请求自动拒绝，不表示自动授予权限。本插件只让不高于当前权限的无效请求不再误入审批路径，不会放行真正的提权请求。

## 工作原理

DSH `0.1.0-rc.6` 的公开 `tools/pre-execute` Waterfall 接收到的参数已经深度冻结，不能在该扩展点修改。插件因此包装目标 `ToolDefinition.execute`，在调用原实现前完成最小参数正规化：

```text
model tool call
  -> resolve current per-session sandbox policy
  -> ignore unnecessary targets, remove an orphan reason, or fill a missing reason
  -> original DSH tool validation and execution
```

插件监听工具和 Agent 生命周期，因此可以处理全局定义、preset scoped shadow、后创建 Agent 和工具 HMR。工具替换或 Agent 销毁后，已经不可见的包装会被恢复并释放；插件卸载后，即使旧包装被其他插件重新挂回，也只会惰性透传参数。

## 平台支持

运行时要求：

- Node.js 24 或更高版本
- DSH `0.1.0-rc.6`
- DSH 支持的 Host 平台

这是针对 DSH `0.1.0-rc.6` `ToolDefinition` 结构的兼容插件。升级 DSH 后应先运行测试并检查上游是否已经原生接受这类无效提权 no-op；上游修复后可以移除此插件。

## 开发

安装依赖并运行完整验证：

```sh
pnpm install
pnpm test
pnpm run pack:check
```

测试覆盖同级与过时低级参数正规化、真正升级保留、缺失理由 fallback、孤立理由清理、非法 target 拒绝、全局和 scoped 工具、不同 Session mode、启动回滚、动态不兼容定义、Agent 生命周期、HMR 清理以及卸载恢复。

## License

MIT
