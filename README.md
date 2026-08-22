# dsh-delete-message

DeepSeek Harness 的消息级删除插件：在每条对话消息的"复制"按钮右侧加一个"删除"图标。点击并确认后，这条消息将从**可见转录**和**模型上下文**中消失——通过宿主官方的 surface-replace 契约实现，不重写日志文件，原始记录保留可恢复。

## 它做什么

- **每条消息一个删除图标**，位于现有复制按钮右侧：
  - 助手回复 → 挂在官方 `conversation.chat.assistant-actions` 槽位（turn-tail 操作条内）；
  - 用户输入 → DOM 增强挂载（宿主暂无用户消息操作条扩展点）。
- **样式与宿主复制按钮完全同语言**（v0.1.2）：官方 `ic_ds_trash_outline_16` 图标几何、28×28 圆形操作按钮的内外边距与悬停底色、primitives `Tooltip` 同款的悬停气泡（不用原生 `title`——系统级提示框在 Windows 上渲染成带边框小方块，看起来像多出一个"删除按钮"）、以及 primitives `Modal`+`Button` 同款的删除确认弹窗（毛玻璃遮罩、380px 卡片、outline 取消 + primary 确认）。
- **点击 → 确认 → 删除**：确认框明确提示"将从历史记录和模型上下文中删除这条消息（日志原文保留，可恢复）"。
- **删除即追加一个占位替换节点**（`surfaceOp: { op: 'replace' }`）——与宿主 `/compact` 同一机制：被遮蔽的消息不再进入 `deriveMessages()`（模型上下文），转录中显示占位行，原始日志字节不动。

## 安全边界

- 删除前宿主端重跑完整校验：仅限已闭合回合中的 `user/message` / `assistant/message` 表面节点；携带工具调用的消息、已被遮蔽的消息、回合进行中的消息一律拒绝，并返回机器原因码（UI 本地化显示）。
- HTTP 路由仅接受回环地址 + 本机 Host 头，双条件校验（与 TokenLedger 同一屏障思路，且这是**写**路径，更严）。
- 插件自身零配置、零依赖；不删除任何文件，不重写任何日志。

## 安装（web profile）

```sh
dsh plugin --profile web add github:viplocco/dsh-delete-message#v0.1.2
```

然后**完全重启 DSH Web 进程**（宿主半边的插件树只在启动时读取）。浏览器半边（`/plugins/dsh-delete-message/client.js`）由宿主按请求从磁盘读取，改动后硬刷新即可。

## 开发

```sh
pnpm test          # node --test；沙箱内用 --test-isolation=none
```

架构、宿主契约与设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

MIT
