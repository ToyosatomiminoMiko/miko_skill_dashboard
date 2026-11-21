/**
 * 插件装配的集成测试：用假 ctx 跑真实的 `apply()`，验证三件事——目录裁剪监听器、
 * `skill` 工具 guard、以及会话选择路由。
 *
 * 为什么需要它：单元测试只证明纯函数对，装配错（监听器名、prepend、依赖服务名、
 * 路由方法）只能在真机上才发现；这里用最小假 ctx 把装配跑一遍，把 DSH 提供的那几个
 * 接口形状钉住。真机上仍需一次端到端验证（新建会话勾选两条 → 发消息 → 看日志）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, SESSION_PATH } from '../index.js'

/** 一条目录消息。 */
function catalogMessage(entries) {
  return {
    id: 'catalog',
    role: 'user',
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
        '',
        '<available_skills>',
        ...entries.map(entry => `- \`${entry.name}\`: ${entry.description}`),
        '</available_skills>',
        '',
        'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation.',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: { kind: 'skill-catalog', form: 'catalog', entries },
  }
}

const ENTRIES = [
  { name: 'alpha', description: 'a' },
  { name: 'beta', description: 'b' },
  { name: 'gamma', description: 'c' },
]

/** 与 DSH 形状一致的技能快照。 */
function snapshotValue() {
  return {
    complete: true,
    skills: ENTRIES.map(entry => ({
      name: entry.name,
      description: entry.description,
      whenToUse: undefined,
      source: 'user-dsh',
      provider: 'filesystem',
      path: `/skills/${entry.name}/SKILL.md`,
      invocation: { modelInvocable: true, userInvocable: true },
    })),
  }
}

/** 最小 Host 上下文：只实现插件真正用到的那几个接口。 */
function createHarness() {
  const listeners = new Map()
  const routes = new Map()
  const agents = new Map()
  const workingDirectory = { ensure: async () => '/ws', defaultDirectory: '/ws' }
  const registry = { snapshot: async () => snapshotValue(), list: async () => snapshotValue().skills }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(name, listener) {
      const bucket = listeners.get(name) ?? []
      bucket.push(listener)
      listeners.set(name, bucket)
      return () => {}
    },
    get(name) {
      if (name === 'skills') return registry
      if (name === 'workingDirectory') return workingDirectory
      return undefined
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => {}
        },
      },
    },
    credentials: { resolve: async () => ({ value: 'secret' }) },
    agents: { get: id => agents.get(id) },
  }
  return { ctx, listeners, routes, agents }
}

/** 一个够用的活体 agent：会话头、事件流、agent 级工具表。 */
function createAgent(id, { published = false } = {}) {
  const events = published ? [{ seq: 0, type: 'user/message', data: catalogMessage(ENTRIES) }] : []
  const guards = []
  const injected = []
  const agent = {
    session: {
      id,
      header: { id, cwd: '/ws', agentPreset: 'standard' },
      snapshotEvents: () => events,
    },
    ctx: {
      tools: {
        guard(fn) {
          guards.push(fn)
          return () => {}
        },
      },
    },
    guards,
    injected,
    inject(message) {
      injected.push(message)
      events.push({ seq: events.length, type: 'user/message', data: message })
    },
  }
  return agent
}

/** 跑一次 pre-step waterfall 的最外层监听器。 */
async function runPreStep(harness, agent, messages) {
  const listeners = harness.listeners.get('agent/pre-step') ?? []
  assert.equal(listeners.length, 1, '期望只注册一个 pre-step 监听器')
  const decision = { kind: 'enter', messages }
  return listeners[0]({ agent }, async () => decision)
}

test('apply 注册会话路由、pre-step 监听器与 agent 生命周期监听器', () => {
  const harness = createHarness()
  apply(harness.ctx, { apiKeyRef: 'X' })
  assert.ok(harness.routes.has(SESSION_PATH))
  assert.ok(harness.routes.has('/api/skill-dashboard.data'))
  assert.equal(harness.listeners.get('agent/pre-step').length, 1)
  assert.equal(harness.listeners.get('agent/created').length, 1)
  assert.equal(harness.listeners.get('agent/disposed').length, 1)
})

test('默认（未选择）时目录原样放行', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s-all')
  const message = catalogMessage(ENTRIES)
  const decision = await runPreStep(harness, agent, [message])
  assert.equal(decision.messages[0], message)
})

test('POST 选择后：新会话的目录被裁剪，且 source.entries 保持完整', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s-blank')
  harness.agents.set('s-blank', agent)
  const route = harness.routes.get(SESSION_PATH)
  const posted = await route.fetch(new Request('http://local/api/skill-dashboard.session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-blank', mode: 'set', names: ['alpha', 'gamma'] }),
  }))
  const body = await posted.json()
  assert.equal(posted.status, 200)
  assert.equal(body.applied, 'session-start')
  assert.deepEqual(body.selection, { mode: 'set', names: ['alpha', 'gamma'] })

  const decision = await runPreStep(harness, agent, [catalogMessage(ENTRIES)])
  const text = decision.messages[0].content[0].text
  assert.match(text, /- `alpha`: a/)
  assert.match(text, /- `gamma`: c/)
  assert.doesNotMatch(text, /- `beta`: b/)
  assert.deepEqual(decision.messages[0].source.entries, ENTRIES)
})

test('guard：未启用的名字被拒绝，启用的名字放行，其它工具不受影响', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s-guard')
  harness.agents.set('s-guard', agent)
  for (const listener of harness.listeners.get('agent/created')) listener({ agent })
  assert.equal(agent.guards.length, 1)

  const route = harness.routes.get(SESSION_PATH)
  await route.fetch(new Request('http://local/api/skill-dashboard.session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-guard', mode: 'set', names: ['beta'] }),
  }))

  const [guard] = agent.guards
  assert.match(guard({ name: 'skill', arguments: { name: 'alpha' } }), /not enabled in this session/)
  assert.equal(guard({ name: 'skill', arguments: { name: 'beta' } }), undefined)
  assert.equal(guard({ name: 'bash', arguments: { name: 'alpha' } }), undefined)
  assert.equal(guard({ name: 'skill', arguments: {} }), undefined)
})

test('guard 在 agent 重建后重新安装（resume 场景）', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const first = createAgent('s-resume', { published: true })
  harness.agents.set('s-resume', first)
  for (const listener of harness.listeners.get('agent/created')) listener({ agent: first })
  harness.listeners.get('agent/disposed')[0]({ agent: first })
  const second = createAgent('s-resume', { published: true })
  harness.agents.set('s-resume', second)
  for (const listener of harness.listeners.get('agent/created')) listener({ agent: second })
  assert.equal(second.guards.length, 1)
})

test('已发布目录的会话改选择：追加一条目录更新消息（下一轮生效）', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s-live', { published: true })
  harness.agents.set('s-live', agent)
  const route = harness.routes.get(SESSION_PATH)
  const posted = await route.fetch(new Request('http://local/api/skill-dashboard.session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-live', mode: 'set', names: [] }),
  }))
  const body = await posted.json()
  assert.equal(body.applied, 'next-step')
  assert.equal(agent.injected.length, 1)
  const injected = agent.injected[0]
  assert.equal(injected.source.kind, 'skill-catalog')
  assert.equal(injected.source.update, true)
  assert.deepEqual(injected.source.entries, ENTRIES)
  assert.deepEqual(injected.content[0].text, injected.content[0].text)
  assert.match(injected.content[0].text, /No skills are enabled in this session/)
})

test('选择能从已发布目录自愈：冷启动后目录仍按当时的启用集裁剪', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  // 制造一条"已被裁剪过"的历史目录（模拟上一个进程写入的会话）。
  const filtered = {
    ...catalogMessage(ENTRIES),
    content: [{ type: 'text', text: catalogMessage(ENTRIES).content[0].text.replace('- `beta`: b\n', '') }],
  }
  const agent = createAgent('s-heal')
  harness.agents.set('s-heal', agent)
  agent.session.snapshotEvents = () => [{ seq: 0, type: 'user/message', data: filtered }]
  const route = harness.routes.get(SESSION_PATH)
  const read = await route.fetch(new Request('http://local/api/skill-dashboard.session?sessionId=s-heal'))
  const body = await read.json()
  assert.deepEqual(body.selection, { mode: 'set', names: ['alpha', 'gamma'] })
})

test('GET 返回候选技能、会话事实与是否已发布目录', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s-get', { published: true })
  harness.agents.set('s-get', agent)
  const route = harness.routes.get(SESSION_PATH)
  const read = await route.fetch(new Request('http://local/api/skill-dashboard.session?sessionId=s-get'))
  const body = await read.json()
  assert.equal(read.status, 200)
  assert.equal(body.session.live, true)
  assert.equal(body.session.published, true)
  assert.deepEqual(body.skills.items.map(skill => skill.name), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(body.selection, { mode: 'all' })
})

test('缺 sessionId 与非法选择都返回 4xx', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const route = harness.routes.get(SESSION_PATH)
  const missing = await route.fetch(new Request('http://local/api/skill-dashboard.session'))
  assert.equal(missing.status, 400)
  const invalid = await route.fetch(new Request('http://local/api/skill-dashboard.session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'x', mode: 'set', names: ['Bad Name'] }),
  }))
  assert.equal(invalid.status, 400)
  const offline = await route.fetch(new Request('http://local/api/skill-dashboard.session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nope', mode: 'all' }),
  }))
  assert.equal(offline.status, 409)
})

test('已发布目录的会话选"全选"：也追加目录更新，且列回全部技能', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  // 先把它裁成只剩 alpha，再选"全选"，模拟"之前关掉了两个技能"的会话。
  const filteredText = `${catalogMessage(ENTRIES).content[0].text.replace('- `beta`: b\n', '').replace('- `gamma`: c\n', '')}`
  const agent = createAgent('s-all-back')
  harness.agents.set('s-all-back', agent)
  agent.session.snapshotEvents = () => [{
    seq: 0,
    type: 'user/message',
    data: { ...catalogMessage(ENTRIES), content: [{ type: 'text', text: filteredText }] },
  }]
  const route = harness.routes.get(SESSION_PATH)
  const posted = await route.fetch(new Request('http://local/api/skill-dashboard.session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-all-back', mode: 'all' }),
  }))
  const body = await posted.json()
  assert.equal(body.selection.mode, 'all')
  assert.equal(body.applied, 'next-step')
  assert.equal(agent.injected.length, 1)
  const text = agent.injected[0].content[0].text
  assert.match(text, /- `alpha`: a/)
  assert.match(text, /- `beta`: b/)
  assert.match(text, /- `gamma`: c/)
})
