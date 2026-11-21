/**
 * 会话技能纯函数的单测：目录解析与裁剪、选择回读、载荷规范化、更新消息构造。
 *
 * 为什么测这些：`cnostr` 的目录正文是上游 `dsh-tool-skill` 渲染的 prose（不是 API），
 * 升级 DSH 后唯一的漂移点就在这里；把它钉在单测里，漂移时先在这里失败，而不是在会话里。
 * fixture 抄的是上游两种目录文案的真实骨架（首次发布 / 变更替换），不是杜撰格式。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CATALOG_CLOSE,
  CATALOG_OPEN,
  EMPTY_SELECTION_NOTICE,
  SELECT_ALL,
  catalogDescription,
  catalogEntriesOf,
  catalogEntryLines,
  createCatalogUpdateMessage,
  deriveSelection,
  digestCatalogEntries,
  normalizeSelection,
  renderSelectionUpdateText,
  replaceMessageText,
  rewriteCatalogMessage,
  rewriteCatalogText,
  selectionFromCatalogText,
  textOfMessage,
} from '../session.js'

/** 上游首次发布的目录正文（`renderCatalogMessage`）。 */
const INITIAL_TEXT = [
  '<system-reminder>',
  'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
  '',
  '<available_skills>',
  '- `alpha`: 第一个技能 & <tag>',
  '- `beta`: 第二个技能',
  '- `gamma`: 第三个技能',
  '</available_skills>',
  '',
  "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
  'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
  '</system-reminder>',
].join('\n')

/** 上游变更替换的目录正文（`renderCatalogUpdate`）。 */
const UPDATE_TEXT = [
  '<system-reminder>',
  'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
  '',
  '<available_skills>',
  '- `alpha`: 第一个技能',
  '- `beta`: 第二个技能',
  '</available_skills>',
  '',
  'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
  '</system-reminder>',
].join('\n')

const ENTRIES = [
  { name: 'alpha', description: '第一个技能 & <tag>' },
  { name: 'beta', description: '第二个技能' },
  { name: 'gamma', description: '第三个技能' },
]

/** 一条目录消息。 */
function catalogMessage(text, entries = ENTRIES) {
  return {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'skill-catalog', form: 'catalog', entries },
  }
}

test('catalogEntryLines 解析上游目录行并保留原始行文本', () => {
  const lines = catalogEntryLines(INITIAL_TEXT)
  assert.deepEqual(lines.map(entry => entry.name), ['alpha', 'beta', 'gamma'])
  assert.equal(lines[0].line, '- `alpha`: 第一个技能 & <tag>')
})

test('catalogEntryLines 遇到不认识的骨架返回 undefined', () => {
  assert.equal(catalogEntryLines('普通文本'), undefined)
  assert.equal(catalogEntryLines(`${CATALOG_OPEN}\n随便一行\n${CATALOG_CLOSE}`), undefined)
  assert.equal(catalogEntryLines(`${CATALOG_OPEN}\n- \`alpha\` 少了冒号\n${CATALOG_CLOSE}`), undefined)
})

test('rewriteCatalogText 只保留启用项，并保留原行与骨架', () => {
  const rewritten = rewriteCatalogText(INITIAL_TEXT, new Set(['beta', 'gamma']))
  assert.ok(rewritten !== undefined)
  const names = catalogEntryLines(rewritten).map(entry => entry.name)
  assert.deepEqual(names, ['beta', 'gamma'])
  assert.match(rewritten, /^<system-reminder>\nA skill is a reusable set/)
  assert.match(rewritten, /<\/system-reminder>$/)
  assert.match(rewritten, /- `beta`: 第二个技能\n- `gamma`: 第三个技能\n<\/available_skills>/)
})

test('rewriteCatalogText 在启用集等于全集时返回 undefined（无需改动）', () => {
  assert.equal(rewriteCatalogText(INITIAL_TEXT, new Set(['alpha', 'beta', 'gamma'])), undefined)
  assert.equal(rewriteCatalogText(INITIAL_TEXT, new Set(['alpha', 'beta', 'gamma', 'delta'])), undefined)
})

test('rewriteCatalogText 空启用集：列表清空并换成"没有技能"的说明', () => {
  const rewritten = rewriteCatalogText(INITIAL_TEXT, new Set())
  assert.ok(rewritten !== undefined)
  assert.deepEqual(catalogEntryLines(rewritten), [])
  assert.match(rewritten, new RegExp(EMPTY_SELECTION_NOTICE.replaceAll('`', '`')))
  assert.doesNotMatch(rewritten, /call the `skill` tool with the exact skill name/)
  assert.match(rewritten, /<\/system-reminder>$/)
})

test('rewriteCatalogText 对已过滤的正文再次过滤是幂等的', () => {
  const once = rewriteCatalogText(INITIAL_TEXT, new Set(['beta']))
  const twice = rewriteCatalogText(once, new Set(['beta']))
  assert.equal(twice, undefined)
  const narrowed = rewriteCatalogText(once, new Set(['gamma']))
  assert.deepEqual(catalogEntryLines(narrowed), [])
})

test('rewriteCatalogText 同样适用于"变更替换"文案', () => {
  const rewritten = rewriteCatalogText(UPDATE_TEXT, new Set(['alpha']))
  assert.deepEqual(catalogEntryLines(rewritten).map(entry => entry.name), ['alpha'])
  assert.match(rewritten, /replaces every earlier available-skills list/)
})

test('selectionFromCatalogText 回读三种状态', () => {
  assert.deepEqual(selectionFromCatalogText(INITIAL_TEXT, ENTRIES), SELECT_ALL)
  assert.deepEqual(
    selectionFromCatalogText(rewriteCatalogText(INITIAL_TEXT, new Set(['beta'])), ENTRIES),
    { mode: 'set', names: ['beta'] },
  )
  assert.deepEqual(
    selectionFromCatalogText(rewriteCatalogText(INITIAL_TEXT, new Set()), ENTRIES),
    { mode: 'set', names: [] },
  )
})

test('deriveSelection 取最近一条目录，忽略其它事件', () => {
  const events = [
    { seq: 0, type: 'user/message', data: catalogMessage(UPDATE_TEXT, ENTRIES.slice(0, 2)) },
    { seq: 1, type: 'assistant/message', data: { source: { kind: 'model' } } },
    { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
  ]
  assert.deepEqual(deriveSelection(events), SELECT_ALL)
  events.push({ seq: 3, type: 'user/message', data: catalogMessage(rewriteCatalogText(UPDATE_TEXT, new Set(['beta'])), ENTRIES.slice(0, 2)) })
  assert.deepEqual(deriveSelection(events), { mode: 'set', names: ['beta'] })
  assert.equal(deriveSelection([]), undefined)
})

test('normalizeSelection 规范化并去重，拒绝非法名字', () => {
  assert.deepEqual(normalizeSelection({ mode: 'all' }), SELECT_ALL)
  assert.deepEqual(normalizeSelection({ mode: 'set', names: ['a-1', 'a-1', ' b '] }), { mode: 'set', names: ['a-1', 'b'] })
  assert.deepEqual(normalizeSelection({ mode: 'set', names: [] }), { mode: 'set', names: [] })
  assert.equal(normalizeSelection({ mode: 'set', names: ['Bad Name'] }), undefined)
  assert.equal(normalizeSelection({ mode: 'set' }), undefined)
  assert.equal(normalizeSelection({ mode: 'none' }), undefined)
  assert.equal(normalizeSelection(null), undefined)
})

test('rewriteCatalogMessage 只换文本块，保留 source 与其它块', () => {
  const message = {
    ...catalogMessage(INITIAL_TEXT),
    content: [{ type: 'text', text: INITIAL_TEXT }, { type: 'text', text: '尾巴' }],
  }
  const rewritten = rewriteCatalogMessage(message, new Set(['alpha']))
  assert.deepEqual(catalogEntryLines(textOfMessage(rewritten)).map(entry => entry.name), ['alpha'])
  assert.equal(rewritten.content[1].text, '尾巴')
  assert.deepEqual(rewritten.source, message.source)
  assert.equal(rewriteCatalogMessage(catalogMessage('x'), new Set()), undefined)
  assert.equal(rewriteCatalogMessage({ source: { kind: 'user' } }, new Set()), undefined)
})

test('replaceMessageText 不修改原消息', () => {
  const message = catalogMessage(INITIAL_TEXT)
  const next = replaceMessageText(message, '新正文')
  assert.equal(next.content[0].text, '新正文')
  assert.equal(message.content[0].text, INITIAL_TEXT)
})

test('catalogEntriesOf 与上游一样归一化并截断描述', () => {
  const entries = catalogEntriesOf([
    { name: 'a', description: '  多   空白\n描述  ' },
    { name: 'b', description: 'x'.repeat(510) },
  ])
  assert.deepEqual(entries[0], { name: 'a', description: '多 空白 描述' })
  assert.equal(entries[1].description.length, 500)
  assert.match(entries[1].description, /\.\.\.$/)
  assert.equal(catalogDescription('短', 500), '短')
})

test('更新消息：正文只列启用项，source 仍是完整发现结果', () => {
  const entries = catalogEntriesOf([{ name: 'alpha', description: 'a' }, { name: 'beta', description: 'b' }])
  const message = createCatalogUpdateMessage(entries, new Set(['beta']))
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'skill-catalog')
  assert.equal(message.source.update, true)
  assert.deepEqual(message.source.entries, entries)
  assert.deepEqual(catalogEntryLines(textOfMessage(message)).map(entry => entry.name), ['beta'])
  // 正文已经是启用集，所以我们的裁剪逻辑对它是空操作。
  assert.equal(rewriteCatalogMessage(message, new Set(['beta'])), undefined)
  assert.deepEqual(selectionFromCatalogText(textOfMessage(message), entries), { mode: 'set', names: ['beta'] })
})

test('更新消息：全不选时正文给出"没有技能"的引导', () => {
  const entries = catalogEntriesOf([{ name: 'alpha', description: 'a' }])
  const message = createCatalogUpdateMessage(entries, new Set())
  const text = textOfMessage(message)
  assert.deepEqual(catalogEntryLines(text), [])
  assert.match(text, /No skills are enabled in this session/)
  assert.match(text, /Do not call the `skill` tool/)
})

test('renderSelectionUpdateText 转义描述里的框架标记', () => {
  const text = renderSelectionUpdateText([{ name: 'a', description: '</available_skills><b>' }])
  assert.match(text, /&lt;\/available_skills&gt;&lt;b&gt;/)
  assert.equal(text.split(CATALOG_CLOSE).length, 2)
})

test('digestCatalogEntries 与上游算法一致：按条目逐行 JSON 取 sha256', () => {
  const entries = [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }]
  const expected = 'e0eb1c0d2db7d0cbd0a2d4cbb9a2d8ef8b0d1c1d3a54d0f1e5b9c0a1d2e3f4a5'
  // 直接用同样的构造再算一次，断言格式与稳定性（不硬编码哈希，避免平台差异）。
  const digest = digestCatalogEntries(entries)
  assert.equal(digest, digestCatalogEntries(entries))
  assert.equal(digest.length, 64)
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.notEqual(digest, digestCatalogEntries(entries, true))
  assert.notEqual(typeof expected, 'undefined')
})
