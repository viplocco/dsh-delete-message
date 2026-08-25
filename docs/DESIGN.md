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

`planDeletion` 按触发目标分三种模式（POST 时宿主端强制重跑）：

| 触发目标 | 模式 | 范围 |
| --- | --- | --- |
| 真实用户输入（source.kind === "user"）或无 source 的行 | `single` | 仅该节点本身 |
| 助手消息 | `turn` | 整个用户输入窗口：各步回复、tool/result、机器注入上下文 |
| 机器注入的 user/message（显式非 user 源，如插件拼接、skill-catalog） | `unit` | 同 `turn` 的窗口语义 |

`unit` 模式存在的理由：请求失败/中断的回合（502 重试耗尽、流中断于任何 `assistant/message` 落盘之前）在界面上只剩"上下文注入"行和重试 chrome——助手侧槽位挂在从不存在的助手气泡里，这些滞留注入行没有任何删除入口，还会在后续每轮请求中重复进入模型上下文。把显式非 user 源的注入行作为单元触发器即可闭合该缺口，真实用户输入仍是永不入列的窗口边界。

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

### 4.5 台账清扫的每快照修订去重门（2026-08-25 性能审计落地）

**背景（CDP 实测审计，`tmp-probe/perf-audit.mjs`，非破坏微基准）**：删除动作本身全一次性有界（视觉隐藏扫描 ~1µs/包装器、fiber 兜底 ~48µs/行、台账 localStorage 写 0.02ms/次），不构成卡顿。唯一常驻开销在删除**之后**：台账非空时，`AssistantDeleteControl` 的 `useEffect([snapshot])` 在每次快照修订都执行一次"全台账 × 全节点 × 全包装器"清扫，而每个回合尾各挂一个控件实例 → 成本 = 控件数 C × O(转录)，随流式修订频度线性放大；空闲（无修订）则零开销。实测 2 控件 / 95 包装器 ≈0.3ms/修订（无感），但超长会话（几十回合尾 + 数千节点全挂载）流式期间可能到感知级。

**修复（模块级 `ledgerSwept` 门）**：清扫是全局的——它隐藏任何台账覆盖的行，不属于某个控件自己——所以每次修订跑一次与跑 C 次 DOM 结果完全相同。第一个观察到某快照对象的 effect 执行清扫并记住该引用，同一快照的其余控件早退；新修订带来新对象，恰好一个控件清扫。两条边界：会话 id 未解析**不落门**（保留被动捕获的重试语义）；空台账**落门早退**（台账增长只发生在点击成功与 preflight 治愈这两条自带直接隐藏的路径上，永远不会脱离新快照凭空出现）。效果：C×O(转录) 收敛为 O(转录)。

**验证**：84 例单测 + smoke-render 全绿；headless CDP 假台账种子回归（`tmp-probe/verify-dedup.mjs`）：种子 `r:[[0,null]]` 重载后 93/95 包装器经治愈路径隐藏、2 个用户行全部幸存（角色闸完好）、计数器确认清扫执行、清理种子后归零且按钮挂载健康。

### 4.6 删除前预检缓存与图标置灰（2026-08-27 落地）

**共享判定缓存（verdictCache）**：`/status` 预检结果按 `session+seq+scope` 缓存——判定是 scope 相关的（step 与整窗计划可能结论不同）。惰性 TTL，永不轮询：deletable 存活 30s（POST 反正会权威重验）、拒绝只存活 4s（open-turn 这类暂态在流结束后很快自愈）；在途请求去重（requestVerdict），容量上限 600 简单修剪。两个隐藏路径（hideRowsBySeq / hideRowsForSeqViaChatNodes）落删即 `clear()`——同窗口兄弟节点的现实已经改变。

**三个消费者**：
1. **清扫器治愈**（processFlowItem）：一次性 `preflightTried` WeakSet 退役——冷会话首查失败后还能随 TTL 重试，重建行与同 seq 锚点共享同一次往返；
2. **DOM 垃圾桶**（用户行 / chrome 行）：按钮本就悬停显形，判定懒取——首次显形时（tooltip 的 label getter 即触发点）+ 点击时各取一次。LIVE 拒绝打 `data-dshdm-gray`（opacity .35 + cursor:not-allowed）**但仍可点击**：点击跳过 confirm+POST，直接弹本地化原因的通知（不做注定失败的往返）；`already-shadowed` 特例保持静默视觉成功（直接藏行）；气泡文字同步换成原因；
3. **助手槽位 React 控件**：按钮常显，故跟随快照修订刷新——requestVerdict 对新鲜缓存同步返回同一对象引用，React 按 Object.is 中止多余渲染（与 §4.5 同一套防风暴思路）。

**失败开放（fail-open）原则**：/status 不可达 → 无判定 → 图标保持中性、点击照走 confirm→POST——服务端始终是权威（POST 本就重跑 planDeletion）。preflight() 相应支持 scope 参数。

**验证**：84 例单测 + smoke 新增判定缓存契约断言（键隔离/TTL 到期/在途去重/fail-open/localizedReason 回退/置灰与 already-shadowed 豁免）全绿；实机全链路探针 `tmp-probe/verify-preflight.mjs`（fetch 垫片伪造拒绝/放行 + POST 拦截计数，零数据变更）就绪。

### 4.7 删除过渡反馈：确认弹窗 pending 态 + 行退场动画（2026-08-28 落地）

**背景**：点击确认到 POST 返回、行消失之间是三段硬切换——弹窗瞬间 `remove()`、POST 在途零提示（按钮仍可重复点击）、成功行 `display:none` 瞬时跳变。三条入口（用户行/chrome 行/助手槽位）都汇入同一个 `makeDeleteFlow`，在一处改全生效。

**确认弹窗 pending 状态机（openConfirmDialog 重写）**：改为 run 回调式——`run` 执行 POST，返回 `{ok:true,outcome}` / `{ok:false,message,outcome}` 或 throw。点击确认后弹窗进入 pending：主按钮换 spinner + `deleting`（zh "删除中…" / en "Deleting…"），取消/关闭/Esc/遮罩全部失效、重复点击被忽略——顺带根治双击重复 POST；`aria-busy` 同步标注。终局解析恰好一次：成功 → 播放退场动画（遮罩淡出 + 卡片下沉），立即 resolve 让行动画并行开始；失败 → 描述与页脚之间就地显示红色原因行（`role=alert`，复用 `reason.*` 本地化），按钮恢复、可原地重试，resolve 推迟到用户最终放弃（此时返回最后一次 outcome）；从未尝试就取消 → `{kind:"cancel"}`。`makeDeleteFlow` 对外合同不变：cancel → `{ok:false,cancelled:true}`；ok / already-shadowed 原样透传供调用方藏行；**服务端拒绝已由弹窗内联呈现并允许重试，故剥掉 error 码只回 `{ok:false}`**——调用方的通知弹窗分支不再二次打扰（预检门在弹窗之前，行为不变）。网络异常走同一内联路径（fallbackError = `reason.internal`）。openNoticeDialog 共享同一退场动画。

**行退场动画（仅用户触发路径）**：`hideRowsBySeqAnimated` / `hideRowsViaChatNodesAnimated` 与瞬时版共享 `markLedgerForPlan` + 匹配核心，但匹配到的行先打 `data-dshdm-leaving`：JS 量取 offsetHeight 设显式高度 → 强制回流 → 高度塌缩至 0 + 淡出上移（CSS transition），多行按序 40ms 级联（8 行封顶）；transitionend 或 LEAVE_MS+140ms 硬超时先到者结算，最终一律落回权威的 `HIDDEN_MARK`。两条铁律：**台账标记同步先行**——动画途中 React 重建出的孪生行靠已落账的台账经清扫器治愈；**只动自己的内联属性**（height/minHeight/overflow 逐项清空，绝不碰 cssText）——包装器属于宿主。后台治愈/清扫路径保持瞬时隐藏：流式期间成片治愈绝不能级联闪动。`prefers-reduced-motion: reduce` 下所有装饰动画（弹窗出入场、行退场）直接跳过，spinner 保留旋转——冻结的 spinner 读作"卡死"而非"进行中"。

**验证**：84 例单测 + smoke 新增过渡契约断言（deleting 键双语存在、STYLE_TEXT 全部动画标记在位、LEAVE_ATTR 与 CSS 选择器一致、两个 Animated 变体同步落账+清缓存、空计划/null 快照 no-op）全绿。实机探针 `tmp-probe/verify-transition.mjs`（fetch 垫片驱动 pending 态 + spinner/优雅关闭/leaving→HIDDEN_MARK 断言，零数据变更）就绪但**环境受阻**：headless Edge 152 对本 GUI 页面 `Page.navigate` 后数秒内浏览器进程必退（复现多次，与启动参数/起始 URL 无关；GUI 根页本身响应正常）——CDP 实机验证待稳定无头环境或以真实浏览器手动核对。纯 client 半区，硬刷新生效。

**冷宿主即时弹窗（2026-08-28 用户实测反馈补强）**：用户报告重启 dsh web 后点击垃圾桶到确认弹窗出现之间长时间无任何反馈。根因：点击处理器在打开弹窗**之前** `await requestVerdict(...)`——重启后判定缓存为空，首次 /status 往返要等服务端会话冷加载（v0.1.5 曾实测 8s 级），期间 UI 完全静止。修复：点击门控改为**只读同步缓存**（`cachedVerdict`）——新鲜拒绝仍瞬时通知/置灰短路；其余情况（可删/过期/无判定）**立即打开确认弹窗**，网络预检经 `gates.preflight` 移入 run() 回调在 pending 态内执行（spinner 覆盖预检往返）；run 内预检若见 already-shadowed 直接合成成功结局（免一次注定同因的 POST，优雅关窗+静默藏行）。重试语义自然成立：内联拒绝后再点确认即重新预检（拒绝 TTL 4s 内秒回同因）。助手槽位无需改动——其判定本就随快照修订同步在 React state 里。

### 4.8 回归记录：右开窗口持久化进台账，吞掉之后所有助手回复（2026-08-29 落地）

**症状（用户报告）**：删除一条助手消息后，继续在会话中对话，助手的新回复不再显示；自己发的新消息正常。

**根因链（三层合谋）**：
1. **服务端报出右开窗口**：`planUnitDeletion` 的 `range` 与 `buildStatus` 的 `window` 都直接取 `userWindowOf` 语义窗口——当被删单元位于**最后一条真实用户输入之后**（删除最新回复正是最常见情形），右侧无界，`end: null`。
2. **客户端原样落账**：DELETE 响应经 `markLedgerForPlan → ledgerMarkRange`、预检治愈经 `ledgerMarkRange(sessionId, status.window)` 把 `{start: X, end: null}` 持久化进 localStorage 台账。
3. **开侧语义放大为永久吞噬**：`ledgerHas` 把 `end === null` 视为开放侧。seq 只增不减，此后一切 `seq > X` 的非用户行——包括**未来回合**新流式出来的 assistant-step、tool/call、正文——全部被判"已删"，清扫器在每个快照修订即时隐藏。真用户新输入靠角色闸（只认精确 seq）幸存，于是表现为"自己的消息在、助手的回复永远不渲染"。刷新也无法恢复（台账持久化），且与 v0.1.4 的开区间修复不矛盾——那次修的是左侧边界误吞用户行，这次是右侧开放侧吞未来行。

**修复（三层防御）**：
- **服务端钳制（surface.js + plugin.js）**：新增导出 `boundClientWindow(events, window)`——右开侧钳到 `lastEventSeq + 1`。按 append-only 单调性，此刻日志里的一切（含最后一个成员之后的 chrome：llm/retry 链、turn-error 横幅）都严格小于该界，覆盖零损失；未来追加的事件必然 ≥ 该界，永不落入。左开侧保留无害（右界有界后未来行不可能从下方进入）。成员收集仍用语义开窗（inUserWindow），只有**报给客户端的 range/window** 走钳制。`planStepDeletion` 本就双侧有界（{assistantSeq, maxSeq}）不动。
- **客户端拒收（client.js `ledgerMarkRange`）**：`end === null` 的范围一律拒绝入账并打 console.info——防旧版宿主/手工构造的计划投毒。瞬时隐藏计划（asPlan/planCovers，只在点击当下消费一次）保持容忍：当下不存在未来行，覆盖无损。
- **遗留数据自愈（client.js `ledgerFor`）**：加载时丢弃历史版本写入的右开范围并计数提示。被毒数据错藏的行随之自然重现；其中确属已删单元的 chrome 行由预检治愈重新藏起（服务端 window 已有界，写回的也是干净范围）。精确 seq 与有界范围原样保留。

**契约修订**：`planDeletion` 返回的 `range` 与 `/status` 的 `window` 自此**恒有安全整数右界**（此前文档允许 null 开侧）；smoke 中"null end 必须是开放侧"的旧断言反转为"必须拒收"。普适教训：**凡是会被客户端持久化的范围/区间，绝不能带开放边界**——评估时的开侧语义只属于服务端当下的全量视图，一旦跨进程/跨时间传输就必须钳到已知数据的边界。


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
- **v0.1.5**（未发版）：**失败/中断回合可清理 + chrome 行垃圾桶**——
  1. **unit 模式（服务端）**：502 重试耗尽这类回合往往没有 `assistant/message`，助手侧槽位无处安放、注入行永久滞留上下文。`planDeletion` 新增 `unit` 模式：显式非 user 源的注入行与助手消息同样按用户输入窗口整单元计划（真实用户输入/无 source 行保持 single；占位符路由回 assessDeletion 得到 already-shadowed，行为不变）。
  2. **chrome 锚点（服务端）**：转录还渲染以**非表面事件**为锚的行——tool/call 摘要卡、llm/retry 重试行、turn-error 横幅。这些 seq 本身无可替换节点，`planDeletion` 将其一律作为窗口单元触发器处理（同 unit：同窗口、同成员、open-turn 照拒）。真实日志验证 tool/call 与 llm/retry 锚点得到同一份窗口计划。
  3. **客户端挂载泛化**：宿主 `ChatNodeSeat` 包装器自带 `[data-chat-flow-kind]`，kind 门控零 fiber 成本；按 kind 选锚点——context → DisclosureRow 头部 `[data-disclosure-row]`，tool-call → 根卡片 `[data-chat-call-id]`（垃圾桶浮动右上角，实测不遮挡内容），model-retry → `<details><summary>`，turn-error → `role=status` 横幅。幂等判据是**按钮存在性**而非标记（React 流式重建行会丢弃旧子树，持久标记会让图标永不复挂——实测回归教训）；STRIP_MARK 仅作 stray 清扫合法性标记随锚点走；`[data-context-source]` 作为冗余 fiber 锚点。stray 清扫规则改为"父挂载点必须带本插件标记"，助手槽位隐藏计划的 range 不再限定 mode==="turn"。确认文案：context 触发用 `confirmBodyContext`，其余 chrome 用 `confirmBodyAssistant`。
  4. **锚点即探针（headless CDP 实测钉死的根因）**：fiber 探针必须从**锚点元素自身**出发——它位于入口组件（RetryNodeView/ToolCallTree/ContextMessageNodeView/TurnErrorNodeView）的输出内部，`.return` 上溯必然经过携带 `props.node` 的 fiber；而 wrapper 的直接子元素是槽位系统的 `div[data-slot]` 容器，其祖先链永远不会向下穿过入口组件，通用探针对 chrome 行全部 `unresolved`（context 行此前能挂载纯靠 `[data-context-source]` 深层冗余锚点的巧合）。扫描统计写入 `<html data-dshdm-scan>`（wrappers/kinds/mounted 分布），配合 `tmp-probe/cdp-*.mjs` 的 headless Edge CDP 探针在真实页面闭环验证——reload 后 user 4/4、context 7/7、tool-call 7/7、model-retry 2/2、turn-error 1/1 全部挂载。
  5. **Think 卡挂载**：assistant-step 加入白名单，锚点取它内部的 `[data-variant="think"] [data-disclosure-row]`——"Think · …" 折叠卡渲染在 step 节点视图内而非独立 chat 节点；未 settle 的 step 无 finalNode、自动无按钮。实机验证 26 个 assistant-step 中 13 个已 settle 的 Think 卡全部挂载。
  6. **chrome 行按钮悬停显隐**：样式表新增 `[data-chat-flow-key]:hover` 触发规则，chrome 按钮打 `data-dshdm-autohide` 标记，默认 `visibility:hidden`（真正不可点击，防误触）+ `:focus-visible` 键盘可达；用户/助手消息操作条按钮（宿主原生悬停显隐）不动。实机用 CDP 真实 `mouseMoved` 验证：指针移开 `hidden` → 移入 `visible` → 移出 `hidden`（合成 mouseover 事件不会激活 `:hover` 伪类，测不到此行为）。
  7. **删除后即时隐藏回归修复**：v0.1.5 的锚点即探针修只补了 `enhanceChromeRow`，漏了 `resolveWrapperSeq`——而 `hideRowsBySeq` 在删除成功后正是经它解析 chrome 行 seq，解析失败→`planCovers(undefined)`→不设 `HIDDEN_MARK`→行不消失直到刷新。修复：`resolveWrapperSeq` 对 chrome 行同样优先走锚点探针，且 `enhanceChromeRow` 解析成功后把 seq 缓存进 `rowSeqCache` 供 `hideRowsBySeq` 直取。非破坏实机验证：tool-call 39/39、context 4/4、model-retry 6/6 全部经锚点解析出数字 seq（修复前全为 undefined）。
  测试 74 例（surface 39 + http 11 + packaging 24，新增 chrome 锚点 5 例 + 样式/锚点断言 1 例），真实日志只读验证 single/unit 路由符合预期。smoke-render.mjs 的 react-dom 解析改为多候选根回退（host 的 npm 布局会 re-hoist react-dom）。
- **v0.2**（进行中）：**步骤级删除**——多步回合中点击 Think 卡或工具调用卡的垃圾桶只删该步骤（`assistant/message` + 配对 `tool/result`），同窗口其他步骤保留。服务端 `planDeletion` 新增 `scope:"step"` 路由到 `planStepDeletion`：向前扫描找到所属 assistant/message，收集其 + 后续 tool/result（遇下一条 assistant/message、真实用户输入或 turn/end 停止）；range = {start:assistantSeq, end:maxSeq} 供客户端隐藏该步骤的 tool/call chrome。POST body / GET query 新增可选 `scope` 字段；不带 scope 向后兼容现有路由。客户端按 kind 分发 scope：tool-call / assistant-step → "step"（confirmTitleStep + confirmBodyStep + tooltipStep），context → 缺省（confirmTitleWindow + confirmBodyContext + tooltipWindow），model-retry / turn-error → 缺省（confirmTitleWindow + confirmBodyAssistant + tooltipWindow）。弹窗标题、正文、tooltip 三层标注范围。
  另：**性能审计落地**（§4.5）——模块级每快照修订去重门，把删除后台账非空时每次快照修订的清扫成本从 C×O(转录) 收敛为 O(转录)；**删除前预检缓存与图标置灰**（§4.6）——共享 TTL 判定缓存 + 三挂载点拒绝置灰/点击即原因；**删除过渡反馈**（§4.7）——确认弹窗 pending 态（spinner + 防重复提交 + 内联失败可重试）+ 行退场级联动画。均为纯 client 半区，硬刷新生效。
  另：**右开窗口持久化回归修复**（§4.8，2026-08-29）——删除末回合回复后继续对话，助手新回复全部被清扫器吞掉。服务端 `boundClientWindow` 把计划 range 与 /status window 钳到 lastEventSeq+1（宿主半区，需重启），客户端拒收右开范围 + 加载时消毒遗留台账（client 半区，硬刷新）。测试 89 例 + smoke 全绿。
- **撤销（对占位再 append 一个反向引用？评估可行性）。**（原同条目的"删除前预检缓存与图标置灰"已落地，见 §4.6）
- **v1.0**：冷会话支持（fork-rebuild：inspect 全量 → 过滤 → 新会话 + 打开），若宿主届时提供原生编辑缝则迁移过去。
