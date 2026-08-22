# dsh-delete-message 技术方案

状态：**v0.1 设计定稿（骨架已落地，集成验证待做）**。本文档记录"为什么这样设计"，包括每一条被否决的路——被否决的路比选中的路更值得写下来，因为下一次迭代最先想试的就是它们。

---

## 0. 需求

每条对话消息（用户的输入、系统的回复等）的现有"复制"按钮右侧增加一个"删除"图标；点击后提示：将从**历史记录**和**上下文**中删除这条消息。

两个关键词决定了整个设计：

- **历史记录** — 会话持久化日志（`~/.dsh/sessions/<project>/<uuid>/session.jsonl.zstd`，事件溯源、append-only、zstd 压缩 JSONL）。
- **上下文** — 下一轮 LLM 请求派生的消息历史（`session.deriveMessages()`，由"表面 surface"折叠而来）。

## 1. 宿主契约（核实过的关键事实）

以下每条都对宿主安装包 `@deepseek-ai/*@0.1.0-rc.6` 的类型声明/编译产物核实过：

| 事实 | 出处 |
| --- | --- |
| 持久化服务 `ctx.sessionPersistence` 是**纯 append-only**：`create/append/load/inspect/readFrom/list`，无删除 API | `dsh-session-persistence/lib/types/index.d.ts` |
| 会话工件是 zstd 压缩 JSONL；`locate(meta)` 给出绝对路径 | 同上 `SessionLocation` |
| **表面替换原语**：表面事件可携带 `surfaceOp: { op:'replace', start, end }`，被遮蔽节点"stop appearing in derived model messages"；注释明言 "Used by compaction; **any surface-replacing producer may use it**" | `dsh-session/lib/types/types.d.ts` L355-392 |
| live Session 可从 `ctx.sessions.get(id)` 取得；`session.append(type, data, { surfaceOp, sourceEventSeqs })` 在追加点同步校验表面契约（位置有效性、遮蔽覆盖完整性），坏事件当场抛出 | `dsh-session/lib/types/index.d.ts` L106-212 |
| compaction 用同一机制：摘要以 user-role 消息 + replace 落盘，原始日志保留保证重放确定性 | `dsh-compaction/README.md` |
| Web UI 每条消息的操作行是 `MessageIconActions`（复制按钮 → `extraActions` → branch 按钮），user 与 assistant 共用 | `dsh-client-ui-conversation/lib/client.js` L4799 |
| 助手侧官方扩展点：list 槽位 `conversation.chat.assistant-actions`，owner 只传 `messageId`，渲染位置就是复制按钮右侧 | 同上 slots 契约 + TurnTailNodeView |
| **用户消息没有操作条扩展点**：`UserMessageNodeView` 渲染 `MessageIconActions` 时不传 `extraActions` | 同上 L5106-5120 |
| 浏览器半边 = 扫描已装包 `package.json` 的 `dsh.client` 字段 → 单文件 bundle 经 `__ModuleLoader__.load({id, factory(require)})` 注册；槽位经 `ctx.slots.inject(name, () => ctx.slots.register({...}, Component))` | TokenLedger 先例 + `dsh-client-ui-slots/README.md` |
| 宿主半边 HTTP 路由：嵌套 inject 等待 `webServer`/`httpServer` 双名之一（版本相关，两个都真实存在）；exact 路由在 RPC 信任边界之外，必须自建屏障 | TokenLedger `docs/HOST-CONTRACT.md` § 1 |
| Cordis `inject` 必须是数组；可选能力用 `ctx.get()`，声明即必需 | HOST-CONTRACT § 2 |

## 2. 删除语义 —— 选中的路

> **删除 = 追加一个占位 `user/message`，其 `surfaceOp: { op:'replace', start: seq, end: seq }` 引用目标节点。**

效果：

| 层面 | 结果 |
| --- | --- |
| 模型上下文 | `deriveMessages()` 不再投影被遮蔽节点 ✔ |
| 可见转录 | 表面重写后该位置显示占位行"[此消息已被用户删除]" ✔ |
| 持久日志 | append-only，原始字节完整保留，可审计可恢复 ✔ |
| 下游投影 | SQLite 投影 / checkpoint / fork lineage 全部按正常追加处理，零破坏 ✔ |
| 升级安全 | 与 `/compact` 同一公开契约，不碰私有文件格式 ✔ |

这是宿主自己删历史的方式。我们只是把它的触发者从 token 压力换成了用户的一次点击。

### 为什么不是别的路（被否决的）

1. **原位重写 `session.jsonl.zstd`**（解压→过滤→重排 seq→重压缩→原子替换）
   - 违反 contiguous-seq 契约：中间挖掉一条，后续所有 seq 必须前移，而 checkpoint watermark、fork 边界、`sourceEventSeqs` 引用全部按旧 seq 记账——要么全量改写每个引用（等于实现半个宿主），要么留下一份下游读不懂的日志。
   - 与 write-behind 缓冲竞争：live 会话的未落水缓冲会在下次 flush 时覆盖外部修改。
   - SQLite 投影缓存按 revision/watermark 增量折叠，外部改写后投影与日志静默错位。
   - 结论：对**冷会话**勉强可行但收益为零（占位方案已达成同样的上下文效果），对**热会话**是数据损坏制造机。

2. **墓碑自定义事件**
   - `KNOWN_SESSION_EVENT_TYPES` 是生成的封闭集合；未知类型且无 `ignorable` 标记的事件让整份日志拒绝重建；带 `ignorable` 则宿主直接跳过——不影响上下文，等于没删。插件事件注册面官方明言 deferred。

3. **fork 到目标之前**（`sessions.fork(source, boundary)`）
   - 只能截断"之后所有"，不能删中间一条；且产生新 sessionId。作为 v2 的"深度清除"（连同日志一起丢弃的 fork-rebuild）候选保留。

4. **只做前端隐藏**（插件自维护已删清单 + CSS 隐藏）
   - 模型上下文纹丝不动——需求里"从上下文中删除"完全不成立。否决。

## 3. 可删除性规则（v0.1 保守集）

`src/surface.js` 纯函数实现，POST 时宿主端强制重跑（预检结果不作为授权）：

| 规则 | 理由 |
| --- | --- |
| 仅 `user/message` / `assistant/message` 表面节点 | tool/result 与其调用点成对存在；单独剪除一半会让派生历史含未应答的工具调用 |
| 目标当前在表面上（自身 `surfaceOp === 'append'` 且未被后续 replace 引用/覆盖） | 对已遮蔽节点再删只会堆叠占位符 |
| 不携带工具调用块 | assistant 消息里的 tool_use 是配对的发起端；v1 整体拒绝，v2 再考虑"call+result 成组删除" |
| 所在回合已闭合（日志中存在配对 `turn/end`，即使 end 在更高 seq） | 回合进行中删除会与 agent 正在写入的历史竞态；compaction 锁同理 |

拒绝一律返回机器原因码（`not-found / not-surface-type / already-shadowed / has-tool-calls / open-turn / append-rejected`），客户端映射为本地化文案。

## 4. UI 挂载 —— 两座桥

用户要求图标出现在"复制按钮右侧"。助手侧有官方座位，用户侧没有：

### 4.1 助手消息（官方槽位）

注册 list 槽位 `conversation.chat.assistant-actions`（owner 传 `messageId`）。组件内：

1. `useSession(selector)` 从会话快照解析 `messageId → 表面 seq`；
2. 解析失败 → 按钮禁用（宁可禁用不可猜）；
3. 点击 → `confirm()` 提示 → `POST /api/delete-message/delete` → 快照刷新自动反映占位行。

### 4.2 用户消息（DOM 增强，明确标注为过渡方案)

宿主的用户消息行（`[data-time-hover-root]` 且非 `[data-turn-tail]`）内部操作条第一个按钮就是复制按钮。MutationObserver 在其后插入同款样式的垃圾桶按钮（借用相邻按钮 class，悬停显隐行为免费继承）。seq 通过 React fiber 从行节点读取（`__reactFiber$*` 上溯找 node props），读不到则拒绝执行并提示。

升级路径：一旦宿主给用户消息提供对称槽位（或 `MessageIconActions` 把 `extraActions` 通到 user 侧），DOM 增强整体退役，两座桥合成一座。代码里 `startDomEnhancement` 单函数封装就是为了那一天整体摘除。

## 5. Host API

| 路由 | 方法 | 语义 |
| --- | --- | --- |
| `/api/delete-message/status?sessionId&seq` | GET | 预检：live + deletable + 原因码（UI 决定图标态） |
| `/api/delete-message/delete` | POST `{sessionId, seq}` | 重跑校验 → `session.append('user/message', 占位, {surfaceOp:{replace,seq,seq}, sourceEventSeqs:[seq]})` |

安全：回环 socket 地址（观察值而非 Host 头）+ 本机 Host 头双条件；body 大小上限；错误带 stack 进 logger.error（HOST-CONTRACT § 5 的教训：吞掉的异常要长得像 bug）。

## 6. 集成验证清单（下一步，动真会话前逐项打勾）

骨架阶段以下假设**标注在代码里**并需实测钉死：

- [ ] `findSeqByMessageId` 的快照路径（`snapshot.chat.nodes/items` 形状）对照真实 ConversationSnapshot 校正；
- [ ] DOM 增强：user 行识别选择器在真实 DOM（CSS modules hash 类名）下命中；fiber 上溯深度够到 node props；
- [ ] 占位 `user/message` data 形状（`id/role/content` 的 ContentBlock 细节）对照真实日志事件确认；
- [ ] 删除后浏览器快照推送是否触发转录重渲染（预期会；若否则补一个显式刷新动作）；
- [ ] `sessionIdOf()`（DOM 路径取当前会话 id）接上运行时的实际 accessor；
- [ ] 安装链路：本地 `link:` 或 Copy-Item 到 profile 安装副本 → `--dump-config` 出现 `# == dsh-delete-message` → `/plugins/dsh-delete-message/client.js` 200 → 重启宿主进程。

## 7. 版本路线

- **v0.1**（本仓库当前）：单条删除（保守规则集）、确认流、占位替换、i18n（zh/en）、测试 39 例。
- **v0.2**：成组删除（assistant tool_use + 其 result 一起 replace）、撤销（对占位再 append 一个反向引用？评估可行性）、删除前预检缓存与图标置灰。
- **v1.0**：冷会话支持（fork-rebuild：inspect 全量 → 过滤 → 新会话 + 打开），若宿主届时提供原生编辑缝则迁移过去。
