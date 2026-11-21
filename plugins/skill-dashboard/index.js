/**
 * 技能仪表盘的 Host 半边：一条只读数据路由（API Key + 技能库存），以及会话级技能选择的
 * 读写路由、目录消息裁剪和 `skill` 工具的硬拦截。
 *
 * 为什么这些数据必须由 Host 算：api_key 只存在于 Host 进程的凭据存储里（浏览器侧只有
 * describe 能力），技能目录也只存在于 Host 的 skills 注册表与 Loader 树里；
 * 而"某个会话启用了哪些技能"必须能改写模型看到的那条目录消息、并能拒绝工具调用，
 * 这两件事都只在 Host 侧发生。
 * 为什么用 connection.fetch 而不是 ctx.remote：Remote 命名空间需要构建期生成的调用描述符，
 * 普通 JS 插件无法提供；fetch 路由是官方给普通插件预留的 Host↔浏览器数据通道。
 * 为什么按 preset 取 skills：本部署的 skill-filesystem 由各 preset 自己 mount（base 层已
 * disable），所以没有 scope 的读取只能看到全局层，会漏掉 preset 注入的技能。
 */

import {
  SELECT_ALL,
  catalogEntriesOf,
  createCatalogUpdateMessage,
  deriveSelection,
  enabledNamesOf,
  normalizeSelection,
  rewriteCatalogMessage,
  selectionFromCatalogText,
  textOfMessage,
} from './session.js'

/** 库存路由在共享 /api 通道下的完整路径；浏览器侧用去掉前导斜杠的相对形式请求。 */
export const DATA_PATH = '/api/skill-dashboard.data'

/** 会话级技能选择路由；GET 读、POST 写。 */
export const SESSION_PATH = '/api/skill-dashboard.session'

/** 未在配置里指定时读取的凭据引用：设置页「模型」里保存的那个 api_key。 */
const DEFAULT_REF = 'DEEPSEEK_API_KEY'

/**
 * 判定一个 Loader 行是否提供技能。
 * 为什么排除 skill-filesystem：它是本地技能发现器（技能来源），不是技能包本身；
 * 而 dsh-skill-badge / dsh-skill-office 这类包才是「装了某个开关才出现的技能」。
 */
const SKILL_PROVIDER_ROW = /^@deepseek-ai\/dsh-skill-(?!filesystem$)/

/** 依赖的 Host 服务：连接路由注册表、凭据服务、技能注册表、活体 agent 表。 */
export const inject = ['connection', 'credentials', 'skills', 'agents']

/**
 * 从本地化元数据对象里挑出请求语言对应的标题。
 * @param title - `meta.title` 的原文，可能是字符串或各语言映射。
 * @param language - HTTP 请求里的语言标签，可能是 `zh-CN` 这类带地区的写法。
 * @returns 标题文本；没有任何可用语言时返回 undefined。
 */
function localizedTitle(title, language) {
  if (typeof title === 'string') return title.length > 0 ? title : undefined
  if (title === null || typeof title !== 'object') return undefined
  const exact = title[language]
  if (typeof exact === 'string' && exact.length > 0) return exact
  const base = language.split('-')[0]
  const short = title[base]
  if (typeof short === 'string' && short.length > 0) return short
  const fallback = title.en ?? title.zh
  if (typeof fallback === 'string' && fallback.length > 0) return fallback
  const first = Object.values(title).find(value => typeof value === 'string' && value.length > 0)
  return first
}

/**
 * 读取完整凭据值；失败时把原因带回浏览器而不是让整条路由 500。
 * @param ctx - Host 上下文。
 * @param ref - 凭据引用。
 * @returns 凭据引用、明文值（未配置时为 null）与错误信息。
 */
async function readApiKey(ctx, ref) {
  try {
    // 每次请求都重新解析：设置页改完密钥后无需重启进程，面板刷新即见新值。
    const resolved = await ctx.credentials.resolve(ref)
    return { ref, value: resolved?.value ?? null, error: null }
  } catch (error) {
    return { ref, value: null, error: String(error?.message ?? error) }
  }
}

/**
 * 把一次技能发现的快照投影成路由可序列化的形状。
 * @param snapshot - `skills.snapshot()` 的结果。
 * @returns `complete` 与技能条目（含两种 invocation 标记）。
 */
function projectCatalog(snapshot) {
  return {
    complete: snapshot.complete,
    items: snapshot.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse ?? null,
      source: skill.source,
      provider: skill.provider,
      path: skill.path ?? null,
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
    })),
  }
}

/**
 * 读取一个工作区 + 一个 preset 视角下的技能目录（冷会话用：没有活体 agent 可取 scope）。
 * @param ctx - Host 上下文。
 * @param cwd - 会话工作目录，决定 project 级技能根。
 * @param requestedPreset - 浏览器给出的会话 preset id；缺省或无效时退回默认 preset。
 * @returns `context`（实际生效的工作区与 preset）与 `skills`（含 invocation 策略的目录）。
 */
async function readSkillCatalog(ctx, cwd, requestedPreset) {
  const presets = ctx.get('agentPresets')
  const roster = presets === undefined ? [] : await presets.list()
  const defaultPreset = presets?.defaultId ?? null
  let preset = requestedPreset !== null && roster.some(entry => entry.id === requestedPreset) ? requestedPreset : null
  if (preset === null) preset = defaultPreset !== null && roster.some(entry => entry.id === defaultPreset) ? defaultPreset : null

  let lease
  let scope
  let effectivePreset = null
  try {
    if (presets !== undefined && preset !== null) {
      try {
        lease = await presets.acquireScope(preset)
        scope = lease.key
        effectivePreset = preset
      } catch {
        // preset 声明损坏时退回全局层，至少让仪表盘显示用户级技能。
        lease = undefined
        scope = undefined
        effectivePreset = null
      }
    }
    const snapshot = await ctx.skills.snapshot({ cwd, ...(scope === undefined ? {} : { scope }) })
    return {
      context: {
        cwd,
        preset: effectivePreset,
        defaultPreset,
        presets: roster.map(entry => ({
          id: entry.id,
          name: entry.name ?? null,
          order: entry.order ?? 0,
          broken: entry.broken ?? null,
        })),
      },
      skills: projectCatalog(snapshot),
    }
  } finally {
    if (lease !== undefined) await lease[Symbol.asyncDispose]()
  }
}

/**
 * 列出「整包都是技能提供者、但当前未启用」的 bundle。
 * 为什么只收整包都是技能行的 bundle：像 SDK profile 这种整 profile 里夹带一个技能行的包，
 * 把它算成「未启用技能」会误导用户去切换整个运行配置。
 * @param ctx - Host 上下文。
 * @param language - 用于挑选 bundle 标题的语言标签。
 * @returns 未启用的技能包摘要。
 */
async function readDisabledSkillBundles(ctx, language) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined) return []
  let bundles
  try {
    bundles = await manager.listBundles()
  } catch {
    return []
  }
  const result = []
  for (const bundle of bundles) {
    if (bundle.enabled === true) continue
    const rows = bundle.rows ?? []
    if (rows.length === 0) continue
    const modules = []
    let skillOnly = true
    for (const row of rows) {
      if (SKILL_PROVIDER_ROW.test(row.moduleName)) modules.push(row.moduleName)
      else skillOnly = false
    }
    if (!skillOnly || modules.length === 0) continue
    result.push({
      name: bundle.name,
      title: localizedTitle(bundle.meta?.title, language) ?? bundle.name,
      description: bundle.description ?? null,
      availability: bundle.availability,
      installed: bundle.installed === true,
      modules,
    })
  }
  return result.sort((left, right) => left.title.localeCompare(right.title))
}

/**
 * 一个会话的工作目录；活体 agent 走 `workingDirectory.ensure`，失败时退回头部记录的 cwd。
 * @param ctx - Host 上下文。
 * @param agent - 活体 agent。
 * @param signal - 请求取消信号。
 * @returns 目录路径，未知时为 null。
 */
async function workingDirectoryOf(ctx, agent, signal) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory !== undefined) {
    try {
      return await workingDirectory.ensure(agent, signal)
    } catch {
      // 目录已不存在时不阻断选择流程，退回创建时的 cwd。
    }
  }
  return agent.session.header.cwd ?? null
}

/**
 * 一个会话视角下的技能目录：活体 agent 用它自己的 scope（与模型看到的完全一致），
 * 冷会话退回 preset scope（与 SessionSkillCatalog Remote 的做法相同）。
 * @param ctx - Host 上下文。
 * @param agent - 活体 agent，冷会话为 undefined。
 * @param cwd - 工作目录。
 * @param preset - 会话记录的 preset id。
 * @param signal - 请求取消信号。
 * @returns 技能目录。
 */
async function listSessionSkills(ctx, agent, cwd, preset, signal) {
  if (agent === undefined) {
    const catalog = await readSkillCatalog(ctx, cwd ?? ctx.get('workingDirectory')?.defaultDirectory ?? process.cwd(), preset ?? null)
    return catalog.skills
  }
  const presets = ctx.get('agentPresets')
  const registry = presets?.serviceFor(agent, 'skills') ?? ctx.get('skills')
  if (registry === undefined) return { complete: false, items: [] }
  const snapshot = await registry.snapshot({ ...(cwd === null || cwd === undefined ? {} : { cwd }), scope: agent, signal })
  return projectCatalog(snapshot)
}

/**
 * 读出一个会话的身份与选择：活体 agent 优先，冷会话通过 sessionQuery 投影读取。
 * @param ctx - Host 上下文。
 * @param sessionId - 会话 id。
 * @param selectionOf - 活体 agent 的选择读取器（由插件闭包提供）。
 * @param signal - 请求取消信号。
 * @returns 会话事实。
 */
async function readSessionFacts(ctx, sessionId, selectionOf, signal) {
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) {
    return {
      agent: live,
      cwd: await workingDirectoryOf(ctx, live, signal),
      preset: live.session.header.agentPreset ?? null,
      origin: live.session.header.origin ?? null,
      live: true,
      selection: selectionOf(live),
    }
  }
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw new Error('sessionQuery service is unavailable')
  const observation = await query.observeSession(sessionId)
  try {
    return {
      agent: undefined,
      cwd: observation.projections?.values?.workingDirectory ?? observation.header.cwd ?? null,
      preset: observation.header.agentPreset ?? null,
      origin: observation.header.origin ?? null,
      live: false,
      selection: deriveSelection(observation.events) ?? SELECT_ALL,
    }
  } finally {
    observation[Symbol.dispose]?.()
  }
}

/** 统一的 JSON 响应，浏览器侧一律 no-store。 */
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * 注册仪表盘与会话技能路由，并接管"模型看到哪些技能"。
 * @param ctx - Host 上下文。
 * @param config - 插件行配置；`apiKeyRef` 指定要读取的凭据引用。
 */
export function apply(ctx, config) {
  const ref = typeof config?.apiKeyRef === 'string' && config.apiKeyRef.trim().length > 0
    ? config.apiKeyRef.trim()
    : DEFAULT_REF

  /** 会话选择：进程内缓存，blank 会话期是唯一存储；已发布目录的会话可从日志自愈。 */
  const selections = new Map()
  /** 已装 guard 的 agent（同一会话重建 agent 后要重装）。 */
  const guardOwners = new Map()

  /**
   * 读一个 agent 当前的选择。
   * 顺序：进程内选择 → 从已发布目录回读 → 默认全开（等价于插件不存在）。
   * 回读结果也缓存：会话日志只会追加，同一次进程内再读结果不会变，这样 pre-step 的热路径
   * 只有一次 Map 查找（否则长会话每步都要倒扫事件）。
   */
  function currentSelection(agent) {
    const id = agent.session.id
    let selection = selections.get(id)
    if (selection === undefined) {
      selection = deriveSelection(agent.session.snapshotEvents()) ?? SELECT_ALL
      selections.set(id, selection)
    }
    return selection
  }

  /**
   * 给一个 agent 装 `skill` 工具的 guard：未启用的名字直接拒绝。
   * 为什么用 guard 而不是影子工具：guard 在调用时按 agent scope 链取，勾选变化不需要重装，
   * 也不会把上游的工具 schema 与调用指引一起顶掉。
   * @param agent - 目标 agent。
   */
  function ensureGuard(agent) {
    const id = agent.session.id
    if (guardOwners.get(id) === agent) return
    guardOwners.set(id, agent)
    ctx.effect(() => agent.ctx.tools.guard((exec) => {
      if (exec.name !== 'skill') return undefined
      const selection = currentSelection(agent)
      if (selection.mode !== 'set') return undefined
      const requested = exec.arguments?.name
      if (typeof requested !== 'string' || requested.length === 0) return undefined
      if (selection.names.includes(requested)) return undefined
      return `skill "${requested}" is not enabled in this session`
    }), 'skill-dashboard: session skill guard')
  }

  // 每个 agent 建好就装上 guard；错误不能让 agent 创建失败。
  ctx.on('agent/created', ({ agent }) => {
    try {
      ensureGuard(agent)
    } catch (error) {
      console.warn(`[skill-dashboard] failed to guard session ${agent.session.id}: ${String(error?.message ?? error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (guardOwners.get(agent.session.id) === agent) guardOwners.delete(agent.session.id)
  })

  // 目录裁剪：等内层（dsh-tool-skill 的发布监听器）先发布完整目录，再按启用集改这一条消息的正文。
  // 为什么 prepend：Cordis 的 waterfall 是 outermost-first，prepend 会 unshift 到监听器表最前，
  // 因此无论谁先加载，我们都一定包在上游发布逻辑之外，`await next()` 之后拿到的是最终 decision。
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter') return decision
      const selection = currentSelection(agent)
      const enabled = enabledNamesOf(selection)
      if (enabled === undefined) return decision
      let changed = false
      const messages = decision.messages.map((message) => {
        const rewritten = rewriteCatalogMessage(message, enabled)
        if (rewritten === undefined) return message
        changed = true
        return rewritten
      })
      return changed ? { ...decision, messages } : decision
    } catch (error) {
      // 解析漂移时原样放行：最坏情况是筛选失效，绝不能让整轮对话失败。
      console.warn(`[skill-dashboard] catalog rewrite skipped: ${String(error?.message ?? error)}`)
      return decision
    }
  }, { prepend: true })

  // 会话级选择路由：GET 读当前选择与候选技能，POST 落地选择并（必要时）注入目录更新消息。
  ctx.effect(() => ctx.connection.fetch.register({
    path: SESSION_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const signal = request.signal
      try {
        if (request.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId')?.trim()
          if (!sessionId) return json({ ok: false, error: 'missing-session-id' }, 400)
          const facts = await readSessionFacts(ctx, sessionId, currentSelection, signal)
          const skills = await listSessionSkills(ctx, facts.agent, facts.cwd, facts.preset, signal)
          return json({
            ok: true,
            fetchedAt: new Date().toISOString(),
            session: {
              id: sessionId,
              cwd: facts.cwd,
              preset: facts.preset,
              live: facts.live,
              subagent: facts.origin === 'subagent',
              published: facts.agent === undefined ? null : hasPublishedCatalog(facts.agent),
            },
            selection: facts.selection,
            skills,
          })
        }
        if (request.method === 'POST') {
          const payload = await request.json().catch(() => undefined)
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
          if (!sessionId) return json({ ok: false, error: 'missing-session-id' }, 400)
          const selection = normalizeSelection(payload)
          if (selection === undefined) return json({ ok: false, error: 'invalid-selection' }, 400)
          // 只有活体 agent 能立刻生效：冷会话连目录更新消息都无处可投，直接拒绝而不是假装成功。
          const live = ctx.agents.get(sessionId)
          if (live === undefined) return json({ ok: false, error: 'session-not-live' }, 409)
          const facts = await readSessionFacts(ctx, sessionId, currentSelection, signal)
          const catalog = await listSessionSkills(ctx, live, facts.cwd, facts.preset, signal)
          const selectable = catalog.items.filter(skill => skill.modelInvocable)
          const known = new Set(selectable.map(skill => skill.name))
          const names = selection.mode === 'set' ? selection.names.filter(name => known.has(name)) : undefined
          const applied = selection.mode === 'all' ? SELECT_ALL : { mode: 'set', names }
          selections.set(sessionId, applied)
          const published = hasPublishedCatalog(live)
          if (published) {
            // 目录已经在会话历史里了：追加一条新的目录消息，让改动在下一轮生效。
            // "全选"也必须发这条（之前发布的可能是裁剪过的目录），否则模型会一直看到旧列表。
            const entries = catalogEntriesOf(selectable)
            const enabled = applied.mode === 'set'
              ? new Set(applied.names)
              : new Set(selectable.map(skill => skill.name))
            live.inject(createCatalogUpdateMessage(entries, enabled))
          }
          return json({
            ok: true,
            session: { id: sessionId, live: true },
            selection: applied,
            applied: published ? 'next-step' : 'session-start',
            ignored: selection.mode === 'set' ? selection.names.filter(name => !known.has(name)) : [],
          })
        }
        return json({ ok: false, error: 'method-not-allowed' }, 405)
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    },
  }), 'skill-dashboard: session skill route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: DATA_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const cwd = url.searchParams.get('cwd')?.trim()
        || ctx.get('workingDirectory')?.defaultDirectory
        || process.cwd()
      const language = url.searchParams.get('lang')?.trim() || 'en'
      try {
        const [apiKey, catalog, disabledSkillBundles] = await Promise.all([
          readApiKey(ctx, ref),
          readSkillCatalog(ctx, cwd, url.searchParams.get('preset')?.trim() || null),
          readDisabledSkillBundles(ctx, language),
        ])
        return json({
          ok: true,
          fetchedAt: new Date().toISOString(),
          apiKey,
          context: catalog.context,
          skills: catalog.skills,
          disabledSkillBundles,
        })
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    },
  }), 'skill-dashboard: dashboard data route')
}

/**
 * 会话历史里是否已经发布过技能目录（决定选择能否在当前会话立刻生效）。
 * @param agent - 活体 agent。
 * @returns 是否已经有一条可读的目录消息。
 */
function hasPublishedCatalog(agent) {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'skill-catalog') continue
    const text = textOfMessage(event.data)
    if (text === undefined) continue
    if (selectionFromCatalogText(text, source.entries) !== undefined) return true
  }
  return false
}
