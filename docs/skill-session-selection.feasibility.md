# 会话级技能启用：可行性研究（技能仪表盘大升级）

> 结论先行：**可行，且不需要修改 DSH 本体**。代价集中在"HOST 侧改写一次性技能目录消息 + 工具调用级硬拦截"，
> 以及"客户端在新会话 hero 里加一枚技能 chip"；风险主要是对上游消息格式的依赖（升级时会漂移），
> 需要一次 2~3 小时的运行时 spike 来定案。
>
> **实现状态（更新）**：方案 A 已落地——Host 侧目录裁剪 + `skill` guard + 两条路由，
> Client 侧新建会话页内嵌技能矩阵（无浮层，直接列在输入卡下方）+ 仪表盘「会话技能」视图；
> 目标与实现约束已写进 `plugins/skill-dashboard/README.md` 的「目标与不变式」表。落地细节与偏差见第 13 节。

---

## 1. 目标

- 技能很多，但不是每次会话都需要。
- 新建会话时能看到技能表，勾选"本次会话启用哪些"。
- 未启用的技能：不出现在模型可见的技能目录里，模型也调用不到（不能只靠提示词"请不要用"）。
- 模型"知道有哪些技能"只靠一条消息
- 顺序问题有官方解法
- "新建会话"这个时间窗很干净

这些目标写入技能`readme.md`,作为对技能的约束,如果有不一致,预期外就演进

---

## 2. 现在的仪表盘是什么

| 半边 | 位置 | 干了什么 |
|---|---|---|
| Host | `plugins/skill-dashboard/index.js` | 注册 `/api/skill-dashboard.data`（GET），返回三样东西：完整 api_key、按 preset 视角算出的技能目录（`ctx.skills.snapshot({cwd, scope})`）、"整包都是技能、但当前未启用"的 bundle 列表 |
| Client | `plugins/skill-dashboard/client.js` | 用 `sidebar.panellist` + `main` 两个槽位做一个侧栏入口 + 中央仪表盘页（概览 / API Key / 已加载 / 未启用 四视图），样式只用 `--dsw-alias-*` 主题 token |

关键点：它**只读**，数据按"工作区 + preset"算，和"某个会话"无关；也不碰模型上下文。

---

## 3. 技能是怎么进模型的（这是升级的地基）

链路（源码已确认）：

```
preset 挂 skill-filesystem  ──> ctx.skills (分层注册表: global + 每个 agent scope 一层)
        (每个 preset 自带)            │
                                     ├─ ctx.skills.list/snapshot({cwd, scope})  ← 谁可见取决于 scope(agent)
                                     └─ dsh-tool-skill
                                            ├─ 注册模型工具 `skill`（按需加载 SKILL.md 正文）
                                            ├─ 注册注入监听器：用户消息里出现 /name → 注入正文
                                            └─ 注册 agent/pre-step 监听器：
                                                 把"可用技能目录"作为一条**持久化的 user/message**
                                                 （source.kind = 'skill-catalog'，内含 entries）写进会话，
                                                 并用 sha256 摘要判断是否要更新
```

证据：

- `@deepseek-ai/dsh-skill/src/index.ts`：`snapshot()` / `get()` / `register()`，scope 分层合并（`ScopedLayers`）。
- `@deepseek-ai/dsh-tool-skill/src/index.ts:84` 工具定义；`:181` `/name` 手势；`:217` 目录发布监听器；
  `:258/:289` 两种目录文案（首次/替换）；`:347` 摘要；`:381` 从会话历史读回目录。
- `@deepseek-ai/dsh-agent-loop/src/agent.ts:289` pre-step 先把工具集 resolve 好再开 waterfall，
  `:470` 把 pre-step 决定的 messages **原样持久化** —— 所以我们改写下发的 message 内容，落库的就是改写后的内容。
- 真实会话日志里确认了落库形态：`source:{kind:'skill-catalog', form:'catalog', entries:[{name,description}…]}`。
- 基座里 host 的 `skill-filesystem` / `tool-skill` 是 **disabled** 的（`dsh-web-app/cordis.patch.yml:551`），
  由每个 preset 自己挂（`dsh-web-app/presets/standard.patch.yml:40`）。所以"技能目录"天然是 per-agent 的。

三个直接推论：

1. **模型只从一条消息里知道有哪些技能**（那条 `skill-catalog` 消息），过滤它 = 改动模型认知的入口。
2. **`skill` 工具是普通工具**，工具注册表支持按 agent scope 的 guard（`dsh-tools/src/index.ts:384`、`:393`
   `checkGuards` 按 `exec.agent` 的 scope 链取 guard），可以硬拒未启用名字。
3. 工具集在 pre-step 之前 resolve（`agent.ts:298`）：想靠"新注册一个同名工具"去 shadow 只能在 agent 创建期做；
   而 guard 是按**调用时**的 scope 链取的，只要在该工具被调用前装上就行（agent 创建期或用户勾选时都行）。

---

## 4. 新建会话的真实流程（决定 UI 放哪儿）

1. 点侧栏「新建会话」→ `workspaceController`/`navigation.connectBlank` → `ctx.remote.sessions.create({workspaceId, agentPreset?})`。
2. Host `commands.create()` 立刻 `agents.createSession(...)`，**agent 在此时此刻就已经存在**（`created.agent.id`），
   会话是 blank 状态、还没有任何消息（`dsh-api-session-controller/src/commands.ts:120`）。
3. 客户端进入空白会话 hero：brand mark + 标题 + 一行 `heroWorkspaceRow`
   = 工作区 chip + **`conversation.hero.agentPreset`（preset chip）** + **`conversation.hero.options`（右对齐选项位）**
   （`dsh-client-ui-conversation/.../ConversationContent.tsx:114-133`）。这两个槽位**只在 blank 会话出现**。
4. 用户发第一条消息 → 第一次 pre-step → 技能目录被发布 → 之后它就固化在会话历史里。

→ 所以"新建会话时选技能"有一个干净的时间窗：**blank 会话期间**。

现有的 preset chip 就是同一形态的先例（`dsh-client-ui-agent-preset/src/client/seat-store.ts:140` 起：
stage → 当 blank 会话成为当前会话时 `ctx.remote.agentPresets.select(sessionId, preset)` 立刻下发）。技能 chip 可以照抄这套时序。

---

## 5. 能用的扩展点（已核对）

| 能力 | 接口 | 位置 | 状态 |
|---|---|---|---|
| 读某会话视角的技能目录（含 `modelInvocable` 标记） | `ctx.remote.skills.list({sessionId})`：`sessionSkillCatalog` 服务 | `dsh-api-session-controller/src/skill-catalog.ts` | ✅ 已有，冷热会话都能读 |
| Host 自定义读写路由（owner peer 专用） | `ctx.connection.fetch.register({path, methods, requestBody, fetch})` | `dsh-client-connection/src/rpc.ts:153` | ✅ 现有仪表盘已在用 |
| 全局拦截/改写 pre-step 的 messages | `ctx.on('agent/pre-step', waterfall)` | `dsh-agent/src` 事件表 | ✅ 文档化事件，可 `next()` 后改写 |
| 每 agent 硬拒某次工具调用 | `agent.ctx.tools.guard(fn)` | `dsh-tools/src/index.ts:384` | ✅ guard 按 `exec.agent` 生效 |
| 每 agent 注册（含 agent dispose 自动回收） | `ctx.on('agent/created')` → `agent.ctx.effect(...)` | 事件表 `agent/created` | ✅ |
| 给会话追加"下次生效"的上下文 | `agent.inject()`（P2 备选） | practices 文档 | ✅ |
| 新会话 hero 的 chip 位 | `conversation.hero.options`（list, scope=session，props 带 `sessionId`） | 槽位树 | ✅ |
| 会话内持续可见的 chip 位 | `conversation.input.left` / `conversation.input.model.options` | 槽位树 | ✅（P2） |

槽位 props 已确认：`conversation.hero.options` 标准 props 里有 `sessionId: SessionId`、`useSession`、`useInput` 等选择器钩子。

---

## 6. 方案对比

### A（推荐）改写目录消息 + guard 硬拦截

- **做法**：HOST 插件注册一个 `agent/pre-step` 监听器，并带 `{ prepend: true }`（Cordis 的 `ctx.on(name, fn, { prepend })` 会 unshift，"listeners run outermost-first" ⇒ 无论谁先加载，我们都是**最外层**，可以 `await next()` 之后再做后处理）。
  内层 tool-skill 照常发布完整目录 → 我们把这**一条消息的正文**按"启用的技能"重写（保留 `source.entries` 不动）。
  同时在 `agent/created` 时给该 agent 装 guard：`skill` 工具的参数名不在启用集里 → 拒绝并给一句模型可读的理由。
- **优点**：代码量最小（Host 约 +250~350 行），不复制上游语义，不 shadow 工具，上游的目录生命周期、`skills/change`
  重发、`disable-model-invocation`、`/name` 手势全都原样保留。
- **为什么保留 `source.entries` 不动**：上游用 `entries` 的 sha256 判断"要不要重发目录"。若我们把 `entries` 改成启用集，
  上游会认为历史目录"过期"，**每一步都重发一次完整目录**（虽然能被我们再次改写/丢弃，但是每步无谓开销且容易出岔子）。
  保留完整 `entries` ⇒ 上游摘要一致 ⇒ 稳态零开销。代价：落库的 `source.entries`（发现到的事实）与渲染内容（启用集）不一致，
  这是被限制在插件内部的一个"已知不一致"，只影响我们自己的回读逻辑（回读=用 entries 减去正文行，得到启用集）。
- **风险**：依赖上游两种目录文案的固定骨架（`<system-reminder>…<available_skills>- \`name\`: desc…</available_skills>`），
  DSH 升级改了框架文案就要跟着改；`prepend` 已把"顺序"这条风险基本消掉，剩下的是文案骨架。

### B 影子工具 + 自己发布目录

- 在 `agent.ctx` 注册同名 `skill` 工具（工具注册表明确支持"每 agent 变体"shadow，`dsh-tools/src/index.ts:122` 的错误提示就写了
  "register through that agent's `agent.ctx`"），让上游的 exact-identity 检查失效（上游源码注释写明"scoped same-name shadow
  removes both the schema and its call guidance"），然后自己发布目录（`source: plugin` 之类的自有形态，避开上游摘要循环）。
- **优点**：与顺序无关、目录消息"内容=事实"、完全掌控。
- **缺点**：要复制约 150 行目录发布逻辑 + 60 行工具定义 + 自定义消息 source 的 UI 渲染需要验证；DSH 升级需同步上游语义；
  工具 schema 漂移风险。**保留为 A 的兜底方案**。

### C 换成"每个技能组一个 preset"

- 用现成的 `customSkillDirs`（`dsh-skill-filesystem/src/index.ts:48`）+ 每组一个符号链接目录，做 N 个 preset。
- **优点**：零 Host 代码，纯配置，最稳。
- **缺点**：不是"任意勾选"，是"整组切换"；切 preset 在会话开始后会被 Host 拒绝；preset 列表会被组名污染；
  `includeDefaultRoots:false` 后要自己维护组目录。适合"我只想要 3~5 个固定组合"的情形。

### D 只做提示词软约束

- 把"本次只允许这些技能"作为一条 developer/context 消息塞进去，目录不动。
- **优点**：半天工作量。**缺点**：目录里仍有全部技能、模型照样能调用 —— 不满足"选择启用"的语义，只算提醒。

### 对比表

| | 任意勾选 | 真的看不见/调不到 | 每会话生效 | 侵入性 | 工作量 | 升级漂移风险 |
|---|---|---|---|---|---|---|
| **A 改写目录 + guard** | ✅ | ✅（目录+工具双层） | ✅ | 低（不改 DSH、不改 preset） | 小 | 中（依赖目录文案骨架） |
| B 影子工具 | ✅ | ✅ | ✅ | 中 | 中 | 中（复制上游逻辑） |
| C preset 分组 | ❌（整组） | ✅ | ✅（新建时选） | 极低 | 小 | 低 |
| D 软约束 | ✅ | ❌ | ✅ | 极低 | 极小 | 低 |

**推荐 A**，B 兜底，C 可作为"快捷组合"叠加在 A 之上（组 = 勾选结果的一键套用，不需要真 preset）。

---

## 7. 方案 A 详细设计

### 7.1 数据模型

```
selection = { mode: 'all' }                                   // 默认，等价于今天的行为，不写任何状态
          | { mode: 'set', names: string[], updatedAt: number }  // 只启用这些；names 可以为空（= 本次不用技能）
```

**状态的权威来源（按 practices「会话日志是唯一事实来源」）**：

1. 运行期内存表 `Map<sessionId, selection>`（blank 会话期唯一存储；进程重启后 blank 会话丢失归默认）；
2. 已发布过目录的会话：**从目录消息回读**（`entries` − 正文列出的行 = 启用集）。resume / fork / 冷启动都能自愈；
3. 两者都没有 ⇒ `mode:'all'`。

（不做持久化插件存储；如需要，P2 再加一个 JSON 缓存或 `storageDomain` 表，键为 sessionId。）

### 7.2 Host 侧（新增/改动）

```
inject = ['connection','skills','agentPresets','sessionQuery','workingDirectory','tools','agents','sessions']

boot 时：
  ctx.on('agent/pre-step', async ({agent, signal}, next) => {
    const decision = await next()                     // 内层：上游照常发布/更新完整目录
    if (decision.kind === 'reject') return decision
    const sel = selectionOf(agent)                     // 内存 → 回读日志 → all
    if (sel.mode === 'all') return decision            // 零介入，行为与今天完全一致
    const full = fullEntriesOf(agent)                  // ctx.skills.snapshot（上游已算过，走缓存）
    const enabled = full.filter(e => sel.names.includes(e.name))
    return { ...decision, messages: decision.messages.map(m =>
      isCatalog(m) ? rewriteCatalogText(m, enabled, full) : m) }   // 只改 content，source 原样
  })

agent/created 时（每个 agent 一次，effect 挂在 agent.ctx 上）：
  const sel = selectionOf(agent); if (sel.mode !== 'set') return
  agent.ctx.effect(() => agent.ctx.tools.guard(exec => {
    if (exec.name !== 'skill') return
    const name = exec.arguments?.name
    if (typeof name === 'string' && !sel.names.includes(name))
      return { reason: `skill "${name}" is not enabled in this session` }   // 不泄露未启用技能名
  }))

路由（仍是 owner-only 的 connection.fetch）：
  GET  /api/skill-dashboard.session?sessionId=…  → { session, skills[{name,description,whenToUse,modelInvocable}], selection }
  POST /api/skill-dashboard.session               → { sessionId, mode:'all'|'set', names } → 校验并落地到内存表
  既有 GET /api/skill-dashboard.data              保留（仪表盘库存视图复用）
```

要点：

- 只改写**这一条**消息（`source.kind === 'skill-catalog'`），不碰 system prompt、不碰工具集；
- 空启用集：正文里 `<available_skills>` 块为空，并把引导句改成"本会话未启用任何技能"（只换一句，其余骨架不动）；
- 发现结果为空或 `incomplete` 时不动消息（没东西可藏）；
- pre-step 每步都会跑，但 `mode:'all'` 时是 O(1) 直接返回，未发生目录发布时不会命中任何消息。

### 7.3 Client 侧

- **hero chip（P1，核心）**：在 `conversation.hero.options` 注册 `order: 10` 的 chip：
  `技能 5/13` → 点开一个内联面板/浮层（同 preset chip 的交互形态），列出全部技能（名称 + 一句话描述 + 来源），
  勾选即时 POST（防抖），提供「全选 / 清空 / 上次使用」。`sessionId` 由槽位 props 直接给。
- **仪表盘升级（P2/P3）**：在现有四视图上加「会话技能」视图：技能目录（可按来源/是否 modelInvocable 分组）、
  一键"应用到当前会话"、命名技能组管理（组只是勾选集的快捷方式，落到同一个 POST）。
- **会话内 chip（P2，可选）**：`conversation.input.left` 放同一枚 chip（改动在下一轮生效，界面注明）。
- 复用现有 `client.js` 的样式体系（`--dsw-alias-*` token、`h()` 写 React），locale 走 `ctx.locale`。

### 7.4 时序

```
用户点「新建会话」
  └─ client: sessions.create → sessionId（agent 已创建，blank）
     └─ hero 渲染 → 技能 chip（默认 13/13 或上次使用）
用户勾选 5 个
  └─ POST /api/skill-dashboard.session {sessionId, mode:'set', names:[…]}
     └─ Host: 校验 + 内存表写入（+ 若 agent 已在：装 guard）
用户发第一条消息
  └─ agent/pre-step(waterfall)
       ├─ 内层 tool-skill：发现 13 个 → 发布完整目录消息（entries=13）
       └─ 外层 我们：把正文改成 5 行；source.entries 保持 13
  └─ 落库（user/message，source=skill-catalog，正文=5 行）
模型看到 5 个技能；若它硬猜第 6 个名字调用 skill → guard 拒绝
```

---

## 8. 风险与限制（诚实清单）

1. **依赖上游文案骨架**：目录正文是给模型看的 prose，上游没有承诺格式。升级 DSH 后需回归（我们解析失败时**保持原样、只记日志**，
   绝不让会话报错）；`entries` 在 source 里是结构化字段，这条比正文稳。
2. **顺序风险已可控**：用 `{ prepend: true }` 注册即可保证最外层（`cordis/lib/index.js:903` waterfall 是 outermost-first，
   `register()` 对 `prepend` 走 unshift）。仍建议用 `cordis_inspect_query(ListEvents, 'agent/pre-step')` 自检一次。
3. **`source.entries` 与正文不一致**（有意的取舍，见 6.A）。只影响本插件回读与任何直接读 source 的消费者；目前 DSH 内没有这样的消费者。
4. **guard 只在工具调用这一层**：`/name` 显式手势仍可加载未启用技能（这是刻意保留的"用户显式覆盖"）；
   如果希望连这个也拦，需要在 pre-step 的注入监听器里再判断（P2）。
5. **会话开始后修改选择**：空白会话可以自由改；已开始的会话目录已在历史里，改选择需要**追加一条新的目录更新消息**
   （`source.entries` 取当时完整快照，正文取新启用集 —— 这样上游摘要仍一致、不会每步重发）。
   P1 只做 blank 会话，P2 再做这个更新（并且 UI 明确"下一轮生效"）。
   P1 可先加一个便宜兜底：已开始的会话改选择时用 `agent.inject()` 塞一条"本会话只启用 X/Y/Z"的上下文并立刻换掉 guard，
   目录虽旧、模型也不会越界（P2 再补正式的目录更新消息）。
6. **子代理/工作流会话**：默认 `mode:'all'`（会看到全部技能）。可选择 P2 让子会话按 `parentSession` 继承父选择。
7. **空白会话重启丢选择**：选择只在内存里；重启后 blank 会话回到默认（不影响已开始会话，它们的启用集从日志自愈）。
8. **收益规模**：技能正文按需加载，目录里每个技能只占一行（名字 + ≤500 字描述）。13 个技能过滤到 5 个大约省
   **几百 token**，真正的收益是"路由更准、不误触不相关技能、会话开局更清爽"。不要把它当成省 token 的手段。
9. **与"未启用技能包"是两件事**：bundles 的启用/停用是 profile 级（plugin_manager，需要重启/HMR），
   和本特性的"会话级选择"要在 UI 上明确区分，不要混成一个开关。

---

## 9. 分阶段

| 阶段 | 内容 | 产出 | 估时 |
|---|---|---|---|
| P0 spike | 装一个最小 Host 插件：prepend 一个 pre-step 监听器只打日志（打印 catalog source/正文骨架）+ 决定 guard 并拒绝一次 | 一页验证记录，确认 A 的假设 | 2~3 h |
| P1 最小可用 | Host：selection 内存表 + 改写目录 + guard + 两个路由；Client：hero chip + 勾选浮层（只对 blank 会话生效） | 新会话可勾选，模型只看到勾选的技能 | 2~3 d |
| P2 会话内修改 | 追加目录更新消息、`conversation.input.left` chip、子代理继承、回读自愈 | 会话中也能改 | 2~3 d |
| P3 仪表盘大升级 | 「会话技能」视图、技能组、默认策略（全开/上次使用）、locale en/zh、图标与详情页 | 仪表盘成为技能管理中心 | 2~3 d |
| P4 加固 | 纯函数单测（解析/改写/回读/集合运算）、升级回归脚本、README/DETAIL | 可持续维护 | 1~2 d |

---

## 10. 验证方案

**纯函数单测**（`node --test`，配合 AGENTS.md 的"纯函数 + 单测"要求）：
`parseCatalogLines`、`rewriteCatalogText`、`enabledFromMessage`、`normalizeSelection`、`subsetOf`。

**运行时验证（每个阶段都做）**：
1. `cordis_inspect_query(Event, 'agent/pre-step')` 确认我们的监听器在最外层；`Tool, listTools` 看 `skill` 仍存在。
2. 新建 blank 会话 → 勾 2 个 → 发"你有哪些技能可用？" → 回读会话日志（`~/.dsh/sessions/<cwd>/<id>/session.v*.jsonl.zstd`）
   确认 catalog 正文只列 2 个、`source.entries` 仍是全量。
3. 断言 guard：让模型 `skill('未启用的名字')` → 期望 failed call + 我们给的理由。
4. 回归：不勾选（默认 all）的会话，日志里目录正文与今天完全一致。
5. 回归：`skills/change`（新增一个技能目录）后目录更新仍被过滤；`/name` 手势仍可用。
6. fork 一个已过滤会话 + 重启 Host 再 resume → 选择自愈、guard 重新装上。

**验收标准**：勾选 5 个后，模型上下文里只出现这 5 个；调用其余名字必被拒；不改任何 DSH 包、不改 preset。

---

## 11. 需要你拍板

1. **默认策略**：全开（= 现状，最安全）／记住上次会话的选择／默认"上次使用 + 一键全选"？
2. **展示形态**：hero 一枚 chip 点开浮层（推荐，最省地方）／新建会话自动展开内联技能表（最"显眼"但每次都要看）／两者都要？
3. **会话开始后还能不能改**（P2）：要（多一条目录更新消息，UI 注明下一轮生效）／不要（只在新会话期决定）？
4. **要不要技能组**（"逆向 / 绘图 / 办公"这种命名集合，一键勾选）？
5. **子代理是否继承父会话的选择**？
6. **仪表盘里的 API Key 视图**：保留／挪到设置页／删掉？「未启用技能包」仍走插件页管理，对吧？

---

## 12. 证据索引

- `plugins/skill-dashboard/index.js:72` 按 preset 读技能目录；`:135` 未启用技能包；`:178` 路由注册
- `plugins/skill-dashboard/client.js:887` 两个槽位注册
- `@deepseek-ai/dsh-tool-skill/src/index.ts:84,181,217,258,289,347,381`
- `@deepseek-ai/dsh-skill/src/index.ts:439,470,481,512`
- `@deepseek-ai/dsh-tools/src/index.ts:128,199,384,393`
- `@deepseek-ai/dsh-agent-loop/src/agent.ts:289,298,470`
- `@deepseek-ai/dsh-api-session-controller/src/skill-catalog.ts`（session 级技能 Remote）
- `@deepseek-ai/dsh-api-session-controller/src/commands.ts:120`（create 即建 agent）
- `@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationContent.tsx:114-133`（hero 行与槽位）
- `@deepseek-ai/dsh-client-ui-agent-preset/src/client/seat-store.ts:140`（blank 会话 stage→apply 先例）
- `@deepseek-ai/dsh-client-connection/src/rpc.ts:153`（fetch 路由契约，owner-only）
- `@deepseek-ai/dsh-web-app/cordis.patch.yml:551`、`presets/standard.patch.yml:40`（技能行归 preset 所有）
- `@deepseek-ai/dsh-skill-filesystem/src/index.ts:48`（Config，无 per-skill 开关）

---

## 13. 实现状态（方案 A 已落地）

### 13.1 做了什么

| 层 | 内容 | 文件 |
|---|---|---|
| 纯逻辑 | 目录行解析、按启用集裁剪正文、从已发布目录回读选择、载荷规范化、`update` 消息构造（含与上游一致的描述截断与 sha256 摘要） | `plugins/skill-dashboard/session.js` |
| Host | `agent/pre-step`（`prepend`）裁剪目录、`agent/created` 装 `skill` guard、`GET/POST /api/skill-dashboard.session`、会话选择内存表 + 日志自愈 | `plugins/skill-dashboard/index.js` |
| Client | 新建会话页内嵌技能矩阵（`conversation.hero.options`，绝对定位到输入卡下方，滚动区按矩阵高度预留底部空间）、仪表盘第 5 个视图「会话技能」 | `plugins/skill-dashboard/client.js` |
| 测试 | 33 条：纯函数 17、假 ctx 装配 10、Client 槽位/矩阵渲染/布局契约 6 | `plugins/skill-dashboard/test/*.test.mjs` |

### 13.2 与原设计的偏差（都是有意选择）

1. **展示形态在试用后改成了「整页矩阵」**（原设计是 hero 一枚 chip 点开浮层）。用户试用后要求：
   保留空白会话的虎鲸动画，整页 UI 上移，技能以矩阵直接排在下方，不要点开小按钮。
   现在的做法：矩阵绝对定位在输入卡下方（锚点 `data-composer-seat`），用 `ResizeObserver`
   把矩阵高度写成滚动区的 `padding-bottom`，于是"标题 + 输入卡 + 矩阵"作为一个整体居中，
   等价于把原来孤零零的 hero 整块上移了矩阵高度的一半。矩阵不占流，所以上游 hero 的
   居中/吸附逻辑一行都没改；虎鲸画布（`conversation.hero.frame` 的 PixelWhale）完全没动。
2. **会话内修改不依赖上游 `renderCatalogUpdate`**（它没有导出）：自己渲染一条 `update: true` 的
   `skill-catalog` 消息，`entries` 写完整发现结果、正文只列启用项，并用与上游相同的 sha256 摘要
   让上游不再重发目录。
3. **回读结果也进缓存**（包括默认 `all`）：否则长会话每步都要倒扫事件，pre-step 是热路径。
4. **冷会话改选择返回 409**，不做"存了但永远不生效"的假成功。
5. **guard 装在 `agent/created`**（不是勾选时）：这样 resume / fork 重建 agent 后自动重装，
   勾选变化只改内存表，guard 闭包读最新值。

### 13.3 真机验收清单（重启一次 dsh 之后）

1. 点侧栏「新建会话」→ hero 整体偏上，输入卡下方直接出现技能矩阵（标题 + `已启用 13 / 共 13`），
   虎鲸动画仍在；点掉 2 个方块 → 计数变 `11 / 13`。
2. 发"你有哪些技能可用？"→ 会话日志里那条 `skill-catalog` 正文只有 2 行，`source.entries` 仍是 13 条。
3. 让模型调用一个未启用的技能名 → 期望失败，理由是 `skill "x" is not enabled in this session`。
4. 不勾选（默认）的会话 → 目录正文与今天完全一致（回归）；`/name` 手势仍可用。

日志位置：`~/.dsh/sessions/<打包后的 cwd>/<session-id>/session.v*.jsonl.zstd`（zstd 压缩的 jsonl）。

### 13.4 为什么必须重启一次

本 profile 的 `dsh-hmr` 配置是 `root: []`（只监听配置文件，不监听模块代码），所以 Host 半边的
`index.js` / `session.js` 改动不会热载；Client 半边的 `client.js` 由 `dsh-client-modules` 直接
从磁盘按图取，刷新页面即可生效，但缺少 Host 路由时矩阵只会显示「读取技能目录失败」。
