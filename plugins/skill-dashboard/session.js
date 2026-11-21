/**
 * 会话级技能选择的纯逻辑：解析并改写模型可见的技能目录消息、把已发布目录回读成选择、
 * 以及构造"选择变更"时要注入的目录更新消息。
 *
 * 为什么把这些集中在一个文件：模型可见的技能目录是 `dsh-tool-skill` 渲染的一条持久
 * user/message，骨架是 `<available_skills>`…`</available_skills>`；升级 DSH 时这段文案可能漂移。
 * 所有对它的理解都在本文件，解析失败一律返回 undefined 让调用方原样放行 —— 漂移的后果
 * 只能让筛选失效，绝不能让会话报错。
 * 为什么改写只删行、不重渲染：目录行（HTML 转义、描述截断）都由上游生成，复用原始行能让
 * 筛选后的正文与上游格式逐字节一致；只有"启用集为空"这种上游没有的形态才补一句说明。
 */

import { createHash, randomUUID } from 'node:crypto'

/** 上游目录正文里标记技能列表开始的行。 */
export const CATALOG_OPEN = '<available_skills>'
/** 上游目录正文里标记技能列表结束的行。 */
export const CATALOG_CLOSE = '</available_skills>'
/** 上游目录正文整体包在一条 system-reminder 里。 */
export const REMINDER_CLOSE = '</system-reminder>'

/** 上游的一条目录行：``- `name`: description``；名字不含反引号与换行。 */
const ENTRY_LINE = /^- `([^`\n]+)`: /

/** 技能名的公开语法，与 `dsh-skill` 的 `SKILL_NAME` 一致。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 上游默认的目录描述长度上限；截断规则必须一致才能让摘要与上游对得上。 */
export const DEFAULT_DESCRIPTION_MAX_LENGTH = 500

/** "本次不用任何技能"时替换掉目录后引导句的那段说明。 */
export const EMPTY_SELECTION_NOTICE = 'No skills are enabled in this session: the `skill` tool refuses every name. Do not try names from earlier skill catalogs.'

/** 默认选择：不改变任何行为，等价于插件不存在。 */
export const SELECT_ALL = Object.freeze({ mode: 'all' })

/**
 * 取出正文里的目录行（保持上游顺序）。
 * @param text - 目录消息的正文。
 * @returns 行数组；没有目录骨架时返回 undefined（表示"不是我们认识的目录"）。
 */
export function catalogEntryLines(text) {
  if (typeof text !== 'string') return undefined
  const open = text.indexOf(CATALOG_OPEN)
  if (open < 0) return undefined
  const close = text.indexOf(CATALOG_CLOSE, open + CATALOG_OPEN.length)
  if (close < 0) return undefined
  const lines = []
  for (const raw of text.slice(open + CATALOG_OPEN.length, close).split('\n')) {
    const line = raw.trimEnd()
    if (line.length === 0) continue
    const match = ENTRY_LINE.exec(line)
    // 列表里出现不认识的行就整体放弃：宁可不过滤，也不要写出一条残缺目录。
    if (match === null) return undefined
    lines.push({ name: match[1], line })
  }
  return lines
}

/**
 * 把目录正文裁剪到启用集。
 * @param text - 原始目录正文。
 * @param enabled - 本次会话启用的技能名集合。
 * @returns 裁剪后的正文；无需裁剪或无法识别时返回 undefined（调用方保持原样）。
 */
export function rewriteCatalogText(text, enabled) {
  const lines = catalogEntryLines(text)
  if (lines === undefined) return undefined
  const kept = lines.filter(entry => enabled.has(entry.name))
  if (kept.length === lines.length) return undefined
  const open = text.indexOf(CATALOG_OPEN)
  const close = text.indexOf(CATALOG_CLOSE, open + CATALOG_OPEN.length)
  if (kept.length === 0) {
    // 全禁：列表留空，并把"命中技能就去加载"的引导句换成"本会话没有技能"。
    const head = text.slice(0, open + CATALOG_OPEN.length)
    const end = text.indexOf(REMINDER_CLOSE, close)
    const tail = end < 0 ? '' : `\n${text.slice(end)}`
    return `${head}\n${CATALOG_CLOSE}\n\n${EMPTY_SELECTION_NOTICE}${tail}`
  }
  const head = text.slice(0, open + CATALOG_OPEN.length)
  const tail = text.slice(close)
  return `${head}\n${kept.map(entry => entry.line).join('\n')}\n${tail}`
}

/**
 * 从一条已发布的目录消息回读"当时启用了哪些"。
 * @param text - 消息正文（可能是被本插件裁剪过的）。
 * @param entries - 消息 source 里记录的完整发现结果。
 * @returns 选择；正文不可识别时返回 undefined。
 */
export function selectionFromCatalogText(text, entries) {
  const lines = catalogEntryLines(text)
  if (lines === undefined) return undefined
  const listed = new Set(lines.map(entry => entry.name))
  const discovered = Array.isArray(entries)
    ? entries.map(entry => entry?.name).filter(name => typeof name === 'string')
    : []
  if (discovered.length === 0) {
    return listed.size === 0 ? SELECT_ALL : { mode: 'set', names: [...listed] }
  }
  if (listed.size === discovered.length && discovered.every(name => listed.has(name))) return SELECT_ALL
  return { mode: 'set', names: discovered.filter(name => listed.has(name)) }
}

/**
 * 规范化浏览器提交的选择载荷。
 * @param input - `{mode:'all'}` 或 `{mode:'set', names:[...]}`。
 * @returns 规范化后的选择；非法输入返回 undefined。
 */
export function normalizeSelection(input) {
  if (typeof input !== 'object' || input === null) return undefined
  if (input.mode === 'all') return SELECT_ALL
  if (input.mode !== 'set' || !Array.isArray(input.names)) return undefined
  const names = []
  const seen = new Set()
  for (const value of input.names) {
    if (typeof value !== 'string') return undefined
    const name = value.trim()
    if (name.length === 0 || seen.has(name)) continue
    if (!SKILL_NAME.test(name)) return undefined
    seen.add(name)
    names.push(name)
  }
  return { mode: 'set', names }
}

/** 选择对应的启用名集合；`null` 表示"不过滤"。 */
export function enabledNamesOf(selection) {
  if (selection === undefined || selection.mode !== 'set') return undefined
  return new Set(selection.names)
}

/** 选择是否至少留下一个技能。 */
export function selectionIsEmpty(selection) {
  return selection !== undefined && selection.mode === 'set' && selection.names.length === 0
}

/**
 * 从事件流回读最近一次发布的目录（resume / fork / 冷会话的自愈路径）。
 * @param events - 会话事件，按 seq 升序。
 * @returns 选择；没有可读目录时返回 undefined。
 */
export function deriveSelection(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'skill-catalog') continue
    const text = textOfMessage(event.data)
    if (text === undefined) continue
    const selection = selectionFromCatalogText(text, source.entries)
    if (selection !== undefined) return selection
  }
  return undefined
}

/**
 * 取一条消息里第一个文本块的内容。
 * @param message - 会话消息。
 * @returns 文本；没有文本块时返回 undefined。
 */
export function textOfMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  const block = content.find(candidate => candidate?.type === 'text' && typeof candidate.text === 'string')
  return block?.text
}

/**
 * 把一条目录消息裁剪到启用集（不可识别时原样返回）。
 * @param message - 待处理的消息。
 * @param enabled - 启用名集合。
 * @returns 新的消息对象，或 undefined 表示"不用改"。
 */
export function rewriteCatalogMessage(message, enabled) {
  if (message?.source?.kind !== 'skill-catalog') return undefined
  const text = textOfMessage(message)
  if (text === undefined) return undefined
  const rewritten = rewriteCatalogText(text, enabled)
  if (rewritten === undefined) return undefined
  return replaceMessageText(message, rewritten)
}

/** 只替换第一个文本块，其余块与 source 保持原样。 */
export function replaceMessageText(message, text) {
  let changed = false
  const content = message.content.map((block) => {
    if (changed || block?.type !== 'text') return block
    changed = true
    return { ...block, text }
  })
  return { ...message, content }
}

/**
 * 目录行的转义，与上游 `escapeText` 一致。
 * @param value - 原始描述。
 * @returns 可安全嵌进 system-reminder 的文本。
 */
export function escapeCatalogText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * 描述归一化 + 截断，与上游 `catalogDescription` 一致。
 * @param value - SKILL.md 里的描述。
 * @param maxLength - 长度上限。
 * @returns 与上游逐字符相同的描述。
 */
export function catalogDescription(value, maxLength = DEFAULT_DESCRIPTION_MAX_LENGTH) {
  const normalized = String(value).replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

/**
 * 把技能摘要投影成目录条目（与上游 entries 同形，顺序也照抄）。
 * @param skills - `snapshot()` 或 `list()` 返回的技能摘要，已按模型可见性筛过。
 * @param maxLength - 描述长度上限。
 * @returns `{name, description}` 数组。
 */
export function catalogEntriesOf(skills, maxLength = DEFAULT_DESCRIPTION_MAX_LENGTH) {
  return skills.map(skill => ({
    name: skill.name,
    description: catalogDescription(skill.description ?? '', maxLength),
  }))
}

/**
 * 目录摘要，与上游 `digestCatalogEntries` 逐字节一致。
 * 为什么需要它：注入的"选择变更"消息要写上与上游相同的 entries，上游才会认为目录没有过期；
 * 否则它会在下一步再发一遍完整目录（虽然也会被裁剪，但那是无谓的噪声）。
 * @param entries - 目录条目。
 * @param incomplete - 发现是否不完整。
 * @returns sha256 摘要。
 */
export function digestCatalogEntries(entries, incomplete = false) {
  const canonical = entries.map(entry => JSON.stringify([entry.name, entry.description])).join('\n')
  return createHash('sha256')
    .update(incomplete ? 'incomplete\n' : '')
    .update(canonical)
    .digest('hex')
}

/** 摘要在完整发现与不完整发现下都会出现的两种前缀，回读时不必区分。 */
const UPDATE_HEADER = 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:'
const UPDATE_GUIDANCE = [
  'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
  'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
]
const UPDATE_EMPTY_GUIDANCE = [
  'No skills are enabled in this session. Do not call the `skill` tool, and do not use names from earlier skill catalogs.',
  'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
]

/**
 * 渲染"选择变更"的目录更新正文：只列启用项，但 source 里仍是完整发现结果。
 * @param enabledEntries - 启用项的目录条目。
 * @returns 一条 system-reminder 正文。
 */
export function renderSelectionUpdateText(enabledEntries) {
  return [
    '<system-reminder>',
    UPDATE_HEADER,
    '',
    CATALOG_OPEN,
    ...enabledEntries.map(entry => `- \`${entry.name}\`: ${escapeCatalogText(entry.description)}`),
    CATALOG_CLOSE,
    '',
    ...(enabledEntries.length === 0 ? UPDATE_EMPTY_GUIDANCE : UPDATE_GUIDANCE),
    REMINDER_CLOSE,
  ].join('\n')
}

/**
 * 构造一条可注入的目录更新消息。
 * 为什么复用 `skill-catalog` 这个 source：它是会话格式里已发布的记录形态
 * （`kind/form/update/entries`），上游据此维护"最后一条可见目录"的摘要；
 * 自造一个 source kind 会被会话格式校验拒绝。
 * @param entries - 完整发现结果（与上游要写的 entries 相同）。
 * @param enabled - 启用名集合。
 * @returns 一条 user 角色消息。
 */
export function createCatalogUpdateMessage(entries, enabled) {
  const enabledEntries = entries.filter(entry => enabled.has(entry.name))
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: renderSelectionUpdateText(enabledEntries) }],
    source: { kind: 'skill-catalog', form: 'catalog', update: true, entries },
  }
}
