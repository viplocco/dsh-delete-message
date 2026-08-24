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
| 可见转录 | 宿主**不会**移除原行（见下）——视觉隐藏由插件客户端完成 ✔ |
| 持久日志 | append-only，原始字节完整保留，可审计可恢复 ✔ |
| 下游投影 | SQLite 投影 / checkpoint / fork lineage 全部按正常追加处理，零破坏 ✔ |
| 升级安全 | 与 `/compact` 同一公开契约，不碰私有文件格式 ✔ |

这是宿主自己删历史的方式。我们只是把它的触发者从 token 压力换成了用户的一次点击。

### 可见转录的真相（v0.1.2 误判，实测钉死）

设计定稿时以为"转录中该位置显示占位行"。**错。** 宿主客户端构建人类转录时只收 **append-origin 表面事件**（`dsh-client-runtime` surface.ts：*"a landed replacement would erase conversation the user already saw"*——已落地的替换不能抹掉用户已经看到的话；替换副本仅进模型上下文）。因此：

- 落地 replace 后，原消息行**永远留在界面上**，占位行**永远不渲染**；
- 服务端删除（模型上下文）照常生效，但"界面消失"必须插件自己做。

终稿方案（v0.1.3）：每会话已删 seq 台账（localStorage 持久化）+ 清扫器解析 `[data-chat-flow-key]` 行包装器的 fiber 身份（user/steering/context→`data.seq`，assistant-step→`data.finalNode.seq`，turn-tail→`data.closing.finalNode.seq`）并隐藏命中行；成功删除立即隐藏，未知历史行用一次 `GET /status` 预检治愈（`already-shadowed` 即入账）。

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
   - 模型上下文纹丝不动——需求里"从上下文中删除"完全不成立。**单独使用否决**；但 v0.1.3 起作为服务端 replace 的**互补层**采纳：replace 管上下文，前端隐藏管视觉（见上节）。

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

注册 list 槽位 `conversation.chat.assistant-actions`（owner 传 `messageId`；与官方 feedback 插件同座，注册项声明 `locale: NS` 换取真翻译器）。组件内：

1. `useSession(selector)` 从会话快照解析 `messageId → 表面 seq`（已钉死：settled 助手节点在 `data.finalNode.{messageId,seq}`，admitted steering 节点在 `data.messageId/data.seq`）；
2. 解析失败 → 按钮禁用（宁可禁用不可猜）；`useSession` 面缺失时以惰性钩子替身保持 hook 顺序，降级为禁用而不是崩溃；
3. 点击 → 复刻 Modal 的样式化确认弹窗（正文按本挂载点的静态角色自动选型，见 §4.3）→ `POST /api/delete-message/delete` → 成功即 `hideRowsBySeq`（台账入账 + 立即隐藏对应行）；失败以样式化通知弹窗显示本地化原因。

**v0.1.2 回归教训**：v0.1.1 在组件里写了单参 `jsx(TrashGlyph)`。宿主 React 18.3.1 对缺 props 的 `jsx()` 直接抛 `TypeError: Cannot convert undefined or null to object`——slot 错误边界捕获后**退位（abdicate）整个条目**，控制台一行 "slot entry crashed"，界面上就是"复制按钮右边永远没有删除按钮"。规则沉淀：手写 JSX-runtime 调用时每个 `jsx()/jsxs()` 必须带显式 props 对象；slot 条目渲染期宁可降级也不抛。

### 4.2 用户消息（DOM 增强，明确标注为过渡方案)

宿主的用户消息行（`[data-time-hover-root]` 且非 `[data-turn-tail]`、非 `[data-pending-steering]`）内部操作条是**悬停根的直接子 div 且其直接子节点含按钮**（第一个即复制按钮）。MutationObserver 只认这一种形状并在其后插入同款样式的垃圾桶按钮（借用相邻按钮 class，28×28 盒型、内边距、圆角、悬停底色与悬停显隐全部免费继承）。seq 通过 React fiber 从行节点读取（`__reactFiber$*` 上溯找 node props），读不到则拒绝执行并提示。

v0.1.2 收紧了两条防重复规则：**(a)** 候选条带只取悬停根的直接子 div（旧版 `:scope div` 会命中气泡内部任何含直接按钮的嵌套 div，如 JSON 块头部）；**(b)** 命中的条带立刻打 `data-dsh-delete-enhanced` 标记，重复扫描幂等。另外注入的按钮**不带原生 `title`**——Windows 的系统级提示框是白底黑边小方块，看起来正好像第二个"删除按钮"；悬停提示由复刻 primitives `Tooltip` 的共享气泡承担。

升级路径：一旦宿主给用户消息提供对称槽位（或 `MessageIconActions` 把 `extraActions` 通到 user 侧），DOM 增强整体退役，两座桥合成一座。代码里 `startDomEnhancement` 单函数封装就是为了那一天整体摘除。

### 4.3 确认文案的角色自动判定

早期确认弹窗正文是一句合并文案："……若为助手回复，其思考、工具调用与注入上下文会一并移除……"——把分支判断推给了用户。实际上**每个挂载点的角色是静态事实**，根本不需要判断：

| 挂载点 | 角色（静态） | 文案键 | 陈述的实际范围 |
| --- | --- | --- | --- |
| 官方槽位（只在助手回复的操作行渲染） | `assistant` | `confirmBodyAssistant` | 整段回复单元：思考、工具调用、注入上下文 |
| DOM 增强（只匹配用户行） | `user` | `confirmBodyUser` | 单条消息本身 |

`makeDeleteFlow(t)` 返回的 `runDelete(sessionId, seq, role)` 第三个参数携带的就是这条静态知识——零运行时探测。它与宿主端 `planDeletion` 的语义分叉一一对应：user 目标 `mode:"single"` 仅替换该节点；assistant 目标 `mode:"turn"` 替换整个用户输入窗口（各步回复、tool/result、机器注入上下文）。原 `confirmBody` 保留为未知角色的兜底键。

### 4.4 v0.1.3 回归记录：回合窗口的边界是开区间，用户行只认精确 seq

**症状**：删除第 1 轮的助手回复，前后两条用户输入也一起从界面上消失，只剩下一轮回复——"删一条回复吞掉相邻的用户输入"。服务端 `planDeletion` 无辜（真用户输入只作窗口边界、永不入列），病灶全在客户端隐藏层。

**根因（两处，都在台账对区间的解读上）**：
1. `ledgerHas()` 用**闭区间**比较（`seq >= start && seq <= end`）判断一行是否被回合窗口覆盖。而窗口的 `start/end` 本身就是两侧真用户输入的 seq（`userWindowOf` 语义），于是清扫器把边界上的活用户行当成"已删 chrome"隐藏；`null` 边界还会被比较强转成 0（删除会话第一条回复时会波及它之前的一切用户行）。
2. `ledgerMarkRange()` 的吸收合并用可相切的重叠判断（`<=`/`>=`）：相邻两个窗口共享同一条用户输入作边界时（`[u1,u2]` + `[u2,u3]`）合并成 `[u1,u3]`，共享边界在开区间语义下重新变成"被覆盖"。
3. 同类隐患一并加固：清扫器 preflight 的 `windowCleared` 治愈分支不看节点角色——用户行的预检同样会返回 `windowCleared:true`（它的窗口正是那个已清空的单元），照样把自己藏掉。

**修复（仅 client.js，服务端零改动）**：
- `ledgerHas` 改严格开区间（`>`/`<`，null = 开侧），与 `planCovers` 对齐；
- 吸收合并改双侧严格不等号——只在真正重叠时合并，相切窗口保持独立；
- fiber 行解析顺带记录节点角色（`rowKindCache`）：`processFlowItem` 中 user/steering 行**只能被自己的精确已删 seq 隐藏**（单条删除语义），区间与 `windowCleared` 治愈一概不适用——即使未来某处再写出坏边界，真用户词也有最后一道闸。

**教训**：同一条不变量（"真用户输入是边界、永不被窗口覆盖"）在 `planCovers`、`hideRowsForSeqViaChatNodes` 里都守住了，却在第三个消费点 `ledgerHas` 上以闭区间形式破防。**安全不变量必须收敛到单一实现**，或在每个消费点都有测试钉死——现在冒烟脚本断言了边界开区间、null 开侧、相切不合并、重叠才合并四条契约。


## 5. Host API

| 路由 | 方法 | 语义 |
| --- | --- | --- |
| `/api/delete-message/status?sessionId&seq` | GET | 预检：live + deletable + 原因码（UI 决定图标态） |
| `/api/delete-message/delete` | POST `{sessionId, seq}` | 重跑校验 → `session.append('user/message', 占位, {surfaceOp:{replace,seq,seq}, sourceEventSeqs:[seq]})` |

安全：回环 socket 地址（观察值而非 Host 头）+ 本机 Host 头双条件；body 大小上限；错误带 stack 进 logger.error（HOST-CONTRACT § 5 的教训：吞掉的异常要长得像 bug）。

### 5.1 v0.1.1 回归记录：占位消息必须带 `source`

v0.1.0 的占位 `user/message` 只有 `id/role/content`。`Session.append` 在追加点只校验 JSON 可序列化与表面合同（§2 表格所述），**不校验消息形状**；形状校验（`assertMessageEventShape`）只发生在持久化/查询边界。于是坏记录当场追加成功、静默落盘，会话下次冷加载时整体拒绝：`SessionPersistenceCorruptionError … message has invalid source`（实测 seq 23295，全日志仅此一条坏记录）。

修复：`buildPlaceholder` 补上 `source: { kind: "user" }`——宿主全部第一方 user-message 生产者（headless、commands、session-title、plan-mode 等）都用这个词表。规则沉淀：**凡是往日志追加 `user/message`/`assistant/message`/`tool/result` 的插件，必须在追加点自带满足加载校验的完整消息形状**，不能指望 append 替你把关。

## 6. 集成验证清单（下一步，动真会话前逐项打勾）

骨架阶段以下假设**标注在代码里**并需实测钉死：

- [x] ~~`findSeqByMessageId` 的快照路径~~ —— 两步钉死：(1) 节点载荷——settled 助手节点 `data.finalNode.{messageId,seq}`、steering 节点 `data.messageId/data.seq`；(2) 容器形状——`ConversationSnapshot.chat.nodes` 是 **ChatNodeStore**（带 `get(key)/values()` 的普通对象），不是数组！直接 `for...of` 抛 `nodes is not iterable`，每个 turn-tail 渲染崩一次、边界只显示 ⚠（实测抓到）。终稿经 `values()` 读取并对裸数组保持兼容；
- [x] ~~DOM 增强：user 行 seq 解析~~ —— 注入的垃圾桶按钮没经过 React，自身没有 `__reactFiber$` 键，从它上溯 fiber 永远落空（`could not resolve seq`）。终稿在点击时实时取操作条里第一个非本插件按钮（React 渲染的复制钮）作为 fiber 锚点；
  - v0.1.2 首版用"直接子 div 且含直接子按钮"判定，实测把第三方插件插进消息行的包装 div（如 ↩ 触发器的 portal）也当成了操作条 → 同一行出现第二个垃圾桶。终稿加 **`*_actions` CSS-modules 类名令牌**门槛（宿主操作条恒为 `<hash>_actions [<hash>_actions]`，第三方包装不带），另加节流清扫自愈残留图标；
- [x] ~~助手侧按钮"消失"的最终防御~~ —— 除修复 jsx 单参崩溃外，v0.1.2 终稿给槽位组件套了**自有 ErrorBoundary**（渲染崩溃只打日志并降级为 ⚠ 字形，条目不再退位），订阅 `slots.onEntryError` 把崩溃原因带进我们的日志，并把条目内部的 React Tooltip 换成共享 DOM 气泡（少一层克隆机制）；
- [x] ~~占位 `user/message` data 形状对照真实日志事件确认~~ —— v0.1.1 以最疼的方式完成了这项验证（见 §5.1）：缺 `source` 导致整个会话历史加载失败；
- [x] ~~删除后浏览器快照推送是否触发转录重渲染~~ —— 问题本身问错了：宿主转录**按设计只由 append-origin 事件构成**，replace 既不移除原行也不渲染占位行（见 §2"可见转录的真相"）。视觉消失由插件客户端台账 + 清扫器实现，不依赖任何刷新动作；
- [x] ~~`sessionIdOf()`（DOM 路径取当前会话 id）接上运行时的实际 accessor~~ —— v0.1.2 首版注入 `sessions` 服务实测翻车：插件 fiber 拿到的是惰性取值器，一访问就抛 `cannot get required service "sessions" in inactive context`（点击时成为未捕获拒绝）。终稿改为**纯被动捕获**：助手槽组件渲染时上报 kit 的 `sessionId`，DOM 路径在 fiber 上溯时顺手收集 `props.sessionId`——不 resolve 任何服务，无从抛错；
- [ ] 安装链路：本地 `link:` 或 Copy-Item 到 profile 安装副本 → `--dump-config` 出现 `# == dsh-delete-message` → `/plugins/dsh-delete-message/client.js` 200 → 重启宿主进程。

## 7. 版本路线

- **v0.1**（本仓库当前）：单条删除（保守规则集）、确认流、占位替换、i18n（zh/en）、测试 39 例。
- **v0.1.1**：占位补 `source: { kind: "user" }`（§5.1 回归修复），测试 40 例。
- **v0.1.2**：UI 一致性修复——助手侧条目因单参 `jsx()` 崩溃被错误边界静默退位（按钮"消失"）改写为 feedback 同款注册形态；用户侧条带识别收紧到直接子级 + 幂等标记（消灭重复图标）；官方垃圾桶图标几何、28×28 操作钮样式值、Tooltip 复刻气泡、Modal+Button 复刻确认弹窗全面对齐宿主语言；DOM 路径会话 id 接 `sessions.selected`。测试 44 例 + 渲染冒烟（scripts/smoke-render.mjs，用宿主同款 React 18.3.1 真渲染 slot 组件）。
- **v0.1.3**：四个实测回归的修复——
  1. **删除后界面不消失**（§2 真相节）：宿主转录只收 append-origin 事件，replace 不动界面。新增客户端隐藏层：每会话已删 seq 台账（localStorage，上限 400）+ `[data-chat-flow-key]` 行清扫器（fiber 解析行身份，覆盖 user/steering/context/assistant-step/turn-tail 五种节点）+ `/status` 预检治愈历史行；成功删除立即隐藏。
  2. **失败原因显示原始错误码**（如字面 "already-shadowed"）：宿主 `LocaleRuntime.lookup` 只做一层键查找，嵌套 `reason: {}` 永远查不中。词典改扁平点号键，`translateWith` 先平查再逐级走。
  3. **用户行点击直接弹原生 alert**：点击处理器先查被动捕获的会话 id、后跑 fiber——页面重载后捕获为空时没找就拒绝。改为先解析（多锚点：条带内宿主按钮 → 行包装器探测链）并顺带喂捕获，再校验；所有拒绝/失败统一走复刻 Modal 的通知弹窗，原生 alert 全部退役。
  4. **确认文案按角色自动判定 + 英文全量润色**（§4.3）：`runDelete` 增加静态 `role` 参数，词典拆出 `confirmBodyUser/confirmBodyAssistant`，"若为助手回复"条件句退役；英文 UI 文案整轮完善（`noticeOk` "Got it"→"Dismiss"，全部 `reason.*` 改完整陈述句并统一标点）。冒烟脚本同步两处：台账断言从 v1 裸数组修正为 v2 `{s,r}` 形状（v0.1.3 第 1 项落地时的漏网旧断言），新增角色化文案键的存在性检查。
- **v0.1.4**（当前发版）：**删除回复吞掉相邻用户输入**（§4.4 回归修复，仅客户端半区，硬刷新生效）——`ledgerHas` 对回合窗口闭区间比较（边界即真用户输入的 seq，null 还被强转成 0）、`ledgerMarkRange` 相切合并、preflight `windowCleared` 不分角色，三条路径合谋把窗口两侧的用户行当 chrome 隐藏。修复：开区间语义统一、相切不合并、清扫器按节点角色放行真用户行；冒烟脚本新增四条区间契约断言。
- **v0.2**：成组删除（assistant tool_use + 其 result 一起 replace）、撤销（对占位再 append 一个反向引用？评估可行性）、删除前预检缓存与图标置灰。
- **v1.0**：冷会话支持（fork-rebuild：inspect 全量 → 过滤 → 新会话 + 打开），若宿主届时提供原生编辑缝则迁移过去。
