# @local/skill-dashboard

Harness 左侧栏的一个 dashboard 面板（API Key + 技能库存），外加**会话级技能选择器**：
新建会话页直接以矩阵列出技能，点方块决定"本次会话启用哪些"，未启用的技能既不在模型可见的目录里，
也调不到。它替代了原先独立的 `@local/api-key-panel`（源代码仍保留在 `__server__/plugins/api-key-panel`，
需要时可重新安装）。

## 目标与不变式（这是对实现的约束）

用户目标原文：

- 技能很多，但不是每次会话都需要。
- 新建会话时能看到技能表，勾选"本次会话启用哪些"。
- 未启用的技能：不出现在模型可见的技能目录里，模型也调用不到（不能只靠提示词"请不要用"）。
- 模型"知道有哪些技能"只靠一条消息
- 顺序问题有官方解法
- "新建会话"这个时间窗很干净

由这些目标推出的实现约束，改动时逐条对照：

| # | 约束 | 落在哪儿 |
| --- | --- | --- |
| 1 | 模型对技能的认知**只有一条消息**（`source.kind === 'skill-catalog'` 的持久 user/message），所以筛选只改这一条 | `session.js` `rewriteCatalogMessage` |
| 2 | **只改正文，不改 `source.entries`**：上游用 entries 的 sha256 判断"要不要重发目录"，改成启用集会让它每步重发一次 | `index.js` 的 pre-step 监听器 |
| 3 | **顺序问题用 `{ prepend: true }` 解决**：Cordis waterfall 是 outermost-first，prepend 会 unshift 到监听器表首位，因此无论谁先加载，我们都在上游发布逻辑之外 | `index.js` `ctx.on('agent/pre-step', …, { prepend: true })` |
| 4 | 目录行只删不改：转义与截断由上游生成，复用原始行保证裁剪后与上游逐字节一致 | `session.js` `rewriteCatalogText` |
| 5 | **解析失败一律原样放行**：上游文案是 prose 不是 API，漂移时最坏只能是"筛选失效"，绝不能让会话报错 | `session.js` 全部返回 `undefined` 的路径 |
| 6 | 调不到 = **调用时硬拦截**（`agent.ctx.tools.guard`），不是提示词劝告；勾选变化不需要重装 guard | `index.js` `ensureGuard` |
| 7 | 选择的三级来源：进程内选择 → 从已发布目录回读 → 默认全开（等价于插件不存在） | `index.js` `currentSelection` / `session.js` `deriveSelection` |
| 8 | 空白会话立即生效；已开始的会话**追加一条目录更新消息**，下一轮生效 | `index.js` POST 路由 + `session.js` `createCatalogUpdateMessage` |
| 9 | "未启用的技能**包**"是 profile 级开关（插件页），与本特性（会话级选择）在 UI 与文案上分开 | 仪表盘「未启用」视图 |
| 10 | 新建会话页**直接**摆出技能矩阵，不需要先点开任何东西；虎鲸动画与 hero 的居中/吸附逻辑保持上游原样，只做定位与底部留白 | `client.js` `SessionSkillMatrix` / `SESSION_STYLE` / `useHeroMatrixReserve` |

**如果实现与上表任何一条不一致，视为预期外（缺陷）**：先修实现；只有当目标本身演进时，
才允许改这张表，并在同一次改动里更新对应的单测。

## 页面结构（仪表盘）

| 视图 | 内容 |
| --- | --- |
| 概览 | API Key 状态、已加载技能数、未启用项、当前预设与工作区四张卡片 |
| 会话技能 | 当前会话的勾选表（与新建会话页的矩阵共用同一套读写逻辑，供已开始的会话修改） |
| API Key | 原样显示完整明文密钥（不截断、不掩码）与凭据引用 |
| 已加载技能 | 当前会话模型技能目录里的技能，含来源、描述与 `SKILL.md` 路径 |
| 未启用 | `disable-model-invocation` 的技能，以及随 Harness 提供但未启用的技能包 |

左侧栏图标由 `sidebar.panellist` 槽位生成（id = `skill-dashboard`，order = 20），
页面由 `main` 槽位按同一个 key 派发；内部导航是面板自己的布局。

## 会话技能选择

- **入口**：`conversation.hero.options`（只出现在空白会话）里的一块**整页技能矩阵**——不用点开浮层，
  输入卡下方直接排版所有可对模型开放的技能：标题「本次会话的技能」+ `已启用 2 / 共 13` + 全选/全不选，
  下面是方块网格（技能名 + 来源徽标 + 两行描述），点方块即切换。纯用户技能不进网格，只用一行说明。
- **布局**：矩阵绝对定位在 hero 栈下方（锚点 `[data-composer-seat]`），宽度与输入卡一致
  （读 `--dsh-composer-card-max-width` / `--dsh-composer-side-clearance` 并居中），并用
  `ResizeObserver` 把自身高度写进滚动区的 `--sksp-matrix-reserve`，滚动区据此留出底部空间，
  于是"标题 + 输入卡 + 矩阵"作为一个整体居中——表现就是原来的 hero 整块往上移。
  **不改上游布局**：虎鲸画布（`conversation.hero.frame`）与 hero 的居中/吸附逻辑都保持原样，
  收不到会话 id 或非空白会话时矩阵不渲染。`box-sizing: border-box` 是显式写的：这个 shell
  没有全局 reset，漏了它，滚动区的 padding 会撑高整个 body 而不是让内容区变矮。
- **语义**：`{mode:'all'}` = 默认、不写任何状态、行为与插件不存在完全一致；
  `{mode:'set', names:[…]}` = 只启用这些，**允许空数组**（本次不用任何技能）。
  勾回全集就自动收敛成 `mode:'all'`，不写"全集"这种噪音状态。
- **生效时机**：空白会话（还没发布过目录）→ 第一条消息就按选择下发；
  已开始的会话 → Host `agent.inject()` 一条 `update: true` 的目录消息，下一轮生效
  （矩阵底部直接写明）。冷会话（进程里没有活体 agent）会返回 409，不假装成功。
- **硬拦截**：`skill` 工具的参数名不在启用集 → 返回一句模型可读的
  `skill "x" is not enabled in this session`。`/name` 是用户显式手势，刻意保留
  （那是用户主动覆盖，不是模型越界）。
- **自愈**：选择只存在进程内存里。已开始的会话在 resume / fork / 重启后，从日志里
  最后一条目录消息回读（`entries` 减去正文列出的行 = 启用集），guard 随 agent 重建重装；
  空白会话重启后回到默认（还没有任何目录消息，本来也无从回读）。

## 数据来源

Host 半边注册两条 `connection.fetch` 路由（owner peer 专用），浏览器侧用相对路径请求：

- `GET /api/skill-dashboard.data?cwd=&preset=&lang=` —— 仪表盘库存：
  - `apiKey`：`credentials.resolve(apiKeyRef)` 的结果（引用默认 `DEEPSEEK_API_KEY`）。
  - `context` / `skills`：以 `cwd` + `preset` 调 `ctx.skills.snapshot({ cwd, scope })`，
    scope 通过 `agentPresets.acquireScope()` 取得（本部署的 `skill-filesystem` 由各 preset
    自己 mount，不按 preset 取 scope 会漏掉预设技能）。
  - `disabledSkillBundles`：`pluginManager.listBundles()` 中「整包都是技能提供者且未启用」的包。
- `GET /api/skill-dashboard.session?sessionId=` —— 会话技能：
  活体 agent 用**它自己的 scope** 取技能表（与模型看到的完全一致），冷会话退回 preset scope；
  同时返回 `selection` 与 `session.published`（是否已发布过目录，决定"立即生效"还是"下一轮"）。
- `POST /api/skill-dashboard.session` —— body `{sessionId, mode, names}`：
  校验名字、写入进程内选择、必要时注入目录更新消息；返回
  `{selection, applied:'session-start'|'next-step', ignored:[…]}`。

技能按 `invocation.modelInvocable` 分组：模型目录里的算「已加载」，被
`disable-model-invocation` 挡在模型目录之外的算「未启用」（仍可由 `/name` 调用）。
选择器里只列 `modelInvocable` 的技能，纯用户技能单独用一行说明，不混进勾选表。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：两条路由、目录裁剪监听器、`skill` guard、选择存储 |
| `session.js` | 纯逻辑：目录解析/裁剪/回读、选择规范化、更新消息构造（可单测） |
| `client.js` | Client 半边：仪表盘面板、新建会话页技能矩阵（含整页布局的 CSS 与底部留白测量） |
| `test/*.test.mjs` | `node --test` 单测与假 ctx 装配测试 |

## 测试

```bash
cd plugins/skill-dashboard && node --test test/
```

单测钉住的是**上游目录文案的骨架**（这是 Host 侧唯一的漂移点）、装配形状与矩阵的点选提交；
真机上仍需一次端到端确认：新建空白会话 → 矩阵里只留两条 → 发"你有哪些技能可用？" →
会话日志里那条 `skill-catalog` 正文只有两条、`source.entries` 仍是全量，
且让模型调一个未启用的名字会被拒。

## 已知限制

- 依赖上游两种目录文案的骨架（`<available_skills>`…`</available_skills>`）；DSH 升级改了
  框架文案，筛选会静默失效（不报错），回归时看单测即可发现。
- 矩阵只出现在**空白会话**页；会话一旦开始，入口只剩仪表盘的「会话技能」视图。
- 空白会话的选择只在内存里，进程重启后回到默认。
- 子代理 / 工作流会话默认 `mode:'all'`（看到全部技能），暂不继承父会话的选择。
- 枚举名（`mode:'set'`）没有持久化存储；会话一旦发布过目录，日志就是权威来源。
- 矩阵的整页布局依赖三个稳定的 data 属性（`data-conversation-scroll`、`data-content-phase`、
  `data-composer-seat`）、hero 栈 32px 的底距，以及两个宽度变量（`--dsh-composer-card-max-width`、
  `--dsh-composer-side-clearance`）；上游若改这些，矩阵的位置/宽度/留白会偏，
  但筛选语义不受影响（矩阵仍可点，只是间距不理想）。

## 安装 / 卸载

通过 `plugin_manager` 的 `install_bundle` / `remove_bundle` 操作，包目录即本目录。
颜色全部使用 `--dsw-alias-*` 主题 token，深浅主题自动跟随。
