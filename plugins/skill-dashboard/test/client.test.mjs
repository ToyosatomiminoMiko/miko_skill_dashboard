/**
 * Client 半边的装配与渲染冒烟测试：在 Node 里用最小 React 垫片把 `client.js` 真正跑起来，
 * 检查槽位注册形状、字典完整性，以及几个组件能不能渲染出树。
 *
 * 为什么值得这么干：Client 半边的错误不会出现在 Host 日志里，浏览器控制台也拿不到；
 * 一个拼错的组件名或缺失的字典 key 会让矩阵静默消失。这里用假 `window.__ModuleLoader__`
 * 抓出 factory 与 apply，再用寄存器记录槽位、用垫片渲染组件，把这类错误挡在交付之前。
 * 垫片只实现单次渲染 + 状态复用：第一次渲染跑副作用（发请求），冲洗微任务后重渲染一次，
 * 就能看到"有数据"的那一面。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))

/** 与 Host 路由等价的假数据：3 个可对模型开放的技能 + 1 个纯用户技能。 */
function sessionPayload() {
  return {
    ok: true,
    session: { id: 's-1', cwd: '/ws', preset: 'standard', live: true, subagent: false, published: false },
    selection: { mode: 'set', names: ['alpha'] },
    skills: {
      complete: true,
      items: [
        { name: 'alpha', description: '第一个技能', source: 'user-dsh', modelInvocable: true, userInvocable: true },
        { name: 'beta', description: '第二个技能', source: 'user-dsh', modelInvocable: true, userInvocable: true },
        { name: 'gamma', description: '第三个技能', source: 'bundled', modelInvocable: true, userInvocable: true },
        { name: 'manual', description: '只能手动调用', source: 'user-dsh', modelInvocable: false, userInvocable: true },
      ],
    },
  }
}

/** 仪表盘库存路由的假数据。 */
function dashboardPayload() {
  return {
    ok: true,
    fetchedAt: new Date(0).toISOString(),
    apiKey: { ref: 'DEEPSEEK_API_KEY', value: 'sk-test', error: null },
    context: { cwd: '/ws', preset: 'standard', defaultPreset: 'standard', presets: [{ id: 'standard', name: 'Standard', order: 0, broken: null }] },
    skills: sessionPayload().skills,
    disabledSkillBundles: [],
  }
}

/** 最小 React 垫片：按组件函数分帧保存状态槽，副作用在首次挂载时执行。 */
function createReactShim() {
  const Fragment = Symbol('React.Fragment')
  const frames = new WeakMap()
  const stack = []
  const pending = []
  /** 当前渲染的函数组件状态帧；hooks 只读写栈顶那一帧。 */
  const frame = () => {
    const current = stack[stack.length - 1]
    if (current === undefined) throw new Error('hook called outside a component render')
    return current
  }
  const React = {
    Fragment,
    createElement: (type, props, ...children) => ({
      type,
      props: {
        ...(props ?? {}),
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    }),
    useState(initial) {
      const current = frame()
      const index = current.index++
      if (!(index in current.values)) current.values[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        current.values[index] = typeof next === 'function' ? next(current.values[index]) : next
      }
      return [current.values[index], set]
    },
    useEffect(effect) {
      const current = frame()
      const index = current.index++
      if (current.mounted.has(index)) return
      current.mounted.add(index)
      pending.push(Promise.resolve().then(effect))
    },
    // 垫片不区分绘制前后：布局副作用按普通副作用处理即可。
    useLayoutEffect(effect) {
      React.useEffect(effect)
    },
    useMemo(compute) {
      frame().index++
      return compute()
    },
    useRef(initial) {
      const current = frame()
      const index = current.index++
      if (!(index in current.values)) current.values[index] = { current: initial }
      return current.values[index]
    },
  }
  return {
    React,
    /** 进入一个组件的渲染帧（同一次渲染内按组件函数隔离状态）。 */
    enter(component) {
      const current = frames.get(component) ?? { values: [], index: 0, mounted: new Set() }
      frames.set(component, current)
      current.index = 0
      stack.push(current)
    },
    exit() {
      stack.pop()
    },
    /** 冲洗副作用里排队的微任务与宏任务（假 fetch 会在这里 resolve）。 */
    async flush() {
      for (let round = 0; round < 8; round += 1) {
        const batch = pending.splice(0)
        if (batch.length > 0) await Promise.all(batch)
        await new Promise(resolve => setTimeout(resolve, 0))
        if (batch.length === 0 && pending.length === 0) break
      }
    },
  }
}

/** 把组件树渲染成文本，同时把每个函数组件真正调用一遍。 */
function renderText(node, depth = 0, shim) {
  if (depth > 40) throw new Error('render depth exceeded')
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => renderText(child, depth + 1, shim)).join('')
  if (typeof node.type === 'function') {
    shim.enter(node.type)
    let output
    try {
      output = node.type(node.props)
    } finally {
      shim.exit()
    }
    return renderText(output, depth + 1, shim)
  }
  if (node.type === 'style') return ''
  return renderText(node.props.children, depth + 1, shim)
}

/** 装一个浏览器环境，返回抓到的插件定义与槽位登记表。 */
function loadClient() {
  const shim = createReactShim()
  const registrations = []
  const requests = []
  let loaded = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          loaded = definition
        },
      },
    },
    document: { addEventListener() {}, removeEventListener() {} },
    navigator: { language: 'zh-CN' },
    fetch: async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ url, method, body: init?.body ?? null })
      if (method === 'POST') {
        // 回写提交的选择，让乐观更新的那条路径也能被断言。
        const posted = JSON.parse(String(init.body))
        return new Response(JSON.stringify({
          ok: true,
          selection: posted.mode === 'all' ? { mode: 'all' } : { mode: 'set', names: posted.names },
          applied: 'session-start',
          ignored: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const payload = url.includes('skill-dashboard.session') ? sessionPayload() : dashboardPayload()
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    Response,
    AbortController,
    URLSearchParams,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: 'client.js' })
  assert.ok(loaded !== null, 'client.js 应当调用 window.__ModuleLoader__.load')
  const plugin = loaded.factory((name) => {
    if (name === 'react') return shim.React
    throw new Error(`unexpected require(${name})`)
  })
  const dictionaries = {}
  const ctx = {
    effect(callback) {
      callback()
      return () => {}
    },
    locale: {
      register(namespace, entries) {
        dictionaries[namespace] = entries
      },
      // 缺 key 时返回可见的占位符，测试据此断言字典完整性。
      bind: () => (key, values) => {
        const template = dictionaries['skill-dashboard']?.zh?.[key]
        if (template === undefined) return `«${key}»`
        return values === undefined
          ? template
          : template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match))
      },
    },
    slots: {
      inject(name, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ ...options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  const t = key => dictionaries['skill-dashboard'].zh[key] ?? `«${key}»`
  // 组件必须在一个渲染帧里被调用，hooks 才知道自己属于谁。
  const paint = (component, props) => {
    shim.enter(component)
    try {
      return component(props)
    } finally {
      shim.exit()
    }
  }
  const render = (component, props) => renderText(paint(component, props), 0, shim)
  return { plugin, registrations, dictionaries, shim, requests, t, paint, render }
}

/** 取某个槽位下唯一的一条登记。 */
function single(registrations, name) {
  const matches = registrations.filter(entry => entry.name === name)
  assert.equal(matches.length, 1, `${name} 应当只登记一次`)
  return matches[0]
}

test('注册了仪表盘与新建会话技能矩阵两个位置', () => {
  const { registrations } = loadClient()
  assert.equal(single(registrations, 'main').key, 'skill-dashboard')
  assert.equal(single(registrations, 'sidebar.panellist').id, 'skill-dashboard')
  const matrix = single(registrations, 'conversation.hero.options')
  assert.equal(matrix.id, 'skill-dashboard.session-skills')
  assert.equal(typeof matrix.inject, 'function')
  assert.equal(matrix.inject('s-1').sessionIdFromSlot, 's-1')
  assert.equal(registrations.filter(entry => entry.name === 'shell.overlay').length, 0, '不再有整帧浮层')
})

test('中英字典同 key，渲染时不出现缺 key 的占位符', () => {
  const { dictionaries } = loadClient()
  assert.deepEqual(Object.keys(dictionaries['skill-dashboard']).sort(), ['en', 'zh'])
  assert.deepEqual(
    Object.keys(dictionaries['skill-dashboard'].zh).sort(),
    Object.keys(dictionaries['skill-dashboard'].en).sort(),
  )
})

test('矩阵直接列出技能，点方块即可提交新选择', async () => {
  const { registrations, t, requests, paint, render, shim } = loadClient()
  const matrix = single(registrations, 'conversation.hero.options').component
  const props = { t, sessionId: 's-1', sessionIdFromSlot: 's-1' }
  const tilesOf = () => findHosts(
    paint(matrix, props),
    node => node.type === 'button' && String(node.props?.className ?? '').split(' ').includes('sksp-tile'),
    shim,
  )

  let text = render(matrix, props)
  assert.match(text, /本次会话的技能/)
  assert.match(text, /读取中/, '首帧是加载态')
  await shim.flush()
  assert.ok(requests.some(entry => entry.url.includes('sessionId=s-1')))
  text = render(matrix, props)
  assert.match(text, /已启用 1 \/ 共 3/, '3 个可对模型开放的技能里启用 1 个')
  for (const name of ['alpha', 'beta', 'gamma']) assert.match(text, new RegExp(name))
  assert.match(text, /另有 1 个技能只允许用户手动调用/, '纯用户技能单独说明一行')
  assert.doesNotMatch(text, /manual/, '纯用户技能不进矩阵')
  assert.doesNotMatch(text, /«/)

  const tiles = tilesOf()
  assert.equal(tiles.length, 3, '三个可点选的方块')
  const beta = tiles.find(tile => renderText(tile, 0, shim).includes('beta'))
  assert.ok(beta !== undefined)
  beta.props.onClick()
  await shim.flush()
  text = render(matrix, props)
  assert.match(text, /已启用 2 \/ 共 3/)
  assert.deepEqual(JSON.parse(requests.filter(entry => entry.method === 'POST').at(-1).body),
    { sessionId: 's-1', mode: 'set', names: ['alpha', 'beta'] })

  const gamma = tilesOf().find(tile => renderText(tile, 0, shim).includes('gamma'))
  assert.ok(gamma !== undefined)
  gamma.props.onClick()
  await shim.flush()
  // 勾回全集就收敛成 mode:'all'，不留一份等于全集的名字清单。
  assert.deepEqual(JSON.parse(requests.filter(entry => entry.method === 'POST').at(-1).body),
    { sessionId: 's-1', mode: 'all' })
})

test('矩阵在拿不到会话 id 时不渲染，避免空会话占位', () => {
  const { registrations, paint } = loadClient()
  const matrix = single(registrations, 'conversation.hero.options').component
  assert.equal(paint(matrix, { t: key => key, sessionId: undefined, sessionIdFromSlot: null }), null)
})

test('矩阵样式带着整页布局依赖的三个 data 属性与留白变量', async () => {
  const { registrations, t, paint, render, shim } = loadClient()
  const matrix = single(registrations, 'conversation.hero.options').component
  const props = { t, sessionId: 's-1', sessionIdFromSlot: 's-1' }
  render(matrix, props)
  await shim.flush()
  const styles = findHosts(paint(matrix, props), node => node.type === 'style', shim)
  assert.equal(styles.length, 1, '只注入一份样式')
  const css = styles[0].props.dangerouslySetInnerHTML.__html
  for (const hook of ['data-conversation-scroll', 'data-content-phase', 'data-composer-seat']) {
    assert.ok(css.includes(hook), `样式应当锚定 ${hook}`)
  }
  assert.ok(css.includes('--sksp-matrix-reserve'), '滚动区留白走 CSS 变量')
})

test('仪表盘五个视图都能渲染', async () => {
  const { registrations, shim, t, render } = loadClient()
  const dashboard = single(registrations, 'main').component
  const state = {
    byId: {
      's-1': { id: 's-1', cwd: '/ws', updatedAt: 1, origin: 'user', projectionValues: { agentPreset: 'standard' } },
    },
  }
  const useSessions = (selector, compare) => {
    void compare
    return selector(state)
  }
  render(dashboard, { t, useSessions })
  await shim.flush()
  const text = render(dashboard, { t, useSessions })
  for (const expected of ['技能仪表盘', '概览', '会话技能', 'API Key', '已加载技能', '未启用']) {
    assert.match(text, new RegExp(expected), `概览应当出现 ${expected}`)
  }
  assert.doesNotMatch(text, /«/)
})

/** 递归展开函数组件，收集满足条件的宿主节点（这样能拿到真正的 button 与其 onClick）。 */
function findHosts(node, predicate, shim) {
  const found = []
  const walk = (value, depth = 0) => {
    if (depth > 40) throw new Error('expand depth exceeded')
    if (value === null || value === undefined || typeof value === 'boolean') return
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    if (typeof value.type === 'function') {
      shim.enter(value.type)
      let output
      try {
        output = value.type(value.props)
      } finally {
        shim.exit()
      }
      walk(output, depth + 1)
      return
    }
    if (predicate(value)) found.push(value)
    walk(value.props?.children, depth + 1)
  }
  walk(node)
  return found
}
