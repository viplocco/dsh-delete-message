# dsh-delete-message

DeepSeek Harness 消息级删除插件。在每条消息的操作区提供删除按钮：确认后，该消息经由宿主官方 surface-replace 契约从**模型上下文**移除，并从**可见转录**中隐藏。原始日志字节不做任何改写，随时可恢复。

## 功能

- **全消息类型** — 助手回复挂载于官方 `conversation.chat.assistant-actions` 槽位；用户输入经 DOM 增强（宿主暂无用户侧操作条扩展点）。
- **原生视觉一致** — 复用宿主图标与按钮几何、primitives `Tooltip` 及 `Modal`+`Button` 确认弹窗，明暗主题自动适配。
- **上下文级删除** — 确认后追加 `surfaceOp: { op: 'replace' }` 占位节点（与宿主 `/compact` 同一机制），被遮蔽的消息不再进入 `deriveMessages()`。
- **转录级隐藏** — 宿主可见转录按设计只增不减，因此插件在浏览器端维护每会话已删 seq 台账（localStorage 持久化），解析行包装器的 React fiber 身份隐藏命中行；加载时经 `/status` 预检治愈本浏览器未知的历史已删行。
- **角色化确认弹窗** — 确认文案由挂载点的静态消息角色自动选定，无需用户判断：用户消息陈述单条删除范围；助手回复明确连同思考、工具调用与注入上下文一并移除。
- **中英双语界面** — 全部 UI 文案（确认弹窗、失败原因、无障碍标签等）内置 zh/en 双语，按浏览器语言与宿主偏好自动切换。

## 安全边界

- 服务端删除前重跑完整校验：仅接受已闭合回合中的 `user/message` 与 `assistant/message` 表面节点；携带工具调用的消息、已被遮蔽的消息、进行中的回合一律拒绝，并返回机器原因码（UI 本地化展示）。
- HTTP 写路径双条件屏障：仅接受回环地址且 Host 为本机。
- 插件零配置、零运行时依赖；不删除文件、不改写日志。

## 安装（web profile）

```sh
dsh plugin --profile web add github:viplocco/dsh-delete-message#v0.1.3
```

安装后需**完全重启 DSH Web 进程**（宿主侧插件树仅在启动时读取）；客户端 bundle 由宿主按请求动态 serve，更新后硬刷新即生效。

## 开发

```sh
pnpm test    # node --test
```

架构、宿主契约与设计取舍详见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

MIT
