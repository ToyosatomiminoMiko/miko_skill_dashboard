/**
 * 技能仪表盘的 Client 半边：Harness 左侧栏一个仪表盘入口（中央区域是带内部导航的面板），
 * 以及新建会话页输入卡下方的技能矩阵（勾选本次会话要对模型开放的技能）。
 *
 * 为什么用 sidebar.panellist + main 两个槽位：侧栏的图标列表由 sidebar.panellist 的
 * 注册项生成（id/order/label），点击时调用 ctx.layout.selectPanel(id)，中央面板再由
 * main 槽位按同一个 key 派发；两处 key 必须一致才能点开。
 * 为什么矩阵挂在 conversation.hero.options 上：这个槽位只在空白会话出现，props 直接带
 * sessionId，正是"新建会话、还没发第一条消息"的时间窗；矩阵在这个槽位里绝对定位到输入卡
 * 下方（槽位本身在 hero 行内，属于输入卡上方的窄行），并把自身高度写成滚动区的底部留白，
 * 让整块（标题 + 输入卡 + 矩阵）一起居中——不改上游 hero 布局，虎鲸画布照旧。
 * 为什么页面自己再画一条左侧栏：这是一张 dashboard 而不是单页展示，内部导航把
 * 「概览 / 会话技能 / API Key / 已加载技能 / 未启用」拆开，数据只从 Host 路由取一次。
 * 为什么技能按 modelInvocable 分组：模型技能目录里出现的就是已加载，被
 * disable-model-invocation 挡在模型目录之外的就是未启用（仍可由 /name 调用）。
 */
window.__ModuleLoader__.load({
  id: '@local/skill-dashboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

    /** 面板 id：既是 main 槽位的 key，也是侧栏行的 id。 */
    const PANEL_ID = 'skill-dashboard';
    /** 界面文案命名空间。 */
    const NS = 'skill-dashboard';
    /** 与 Host 路由对应；文档相对写法让被挂载到子路径的部署同样可用。 */
    const DATA_ROUTE = 'api/skill-dashboard.data';
    /** 会话级技能选择路由（GET 读、POST 写）。 */
    const SESSION_ROUTE = 'api/skill-dashboard.session';
    /** 等宽字体栈，用于密钥与技能名这类需要逐字符阅读的内容。 */
    const MONO_FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

    const zh = {
      panel: '技能仪表盘',
      title: '技能仪表盘',
      subtitle: 'API Key 与技能状态',
      'nav.overview': '概览',
      'nav.session': '会话技能',
      'nav.apiKey': 'API Key',
      'nav.loaded': '已加载技能',
      'nav.disabled': '未启用',
      'view.overview.title': '概览',
      'view.overview.sub': '一眼看完 API Key 与技能状态',
      'view.session.title': '会话技能',
      'view.session.sub': '勾选本次会话要对模型开放的技能',
      'view.apiKey.title': 'API Key',
      'view.apiKey.sub': '当前配置的完整凭据',
      'view.loaded.title': '已加载技能',
      'view.loaded.sub': '已进入当前会话的模型技能目录',
      'view.disabled.title': '未启用',
      'view.disabled.sub': '存在但当前未启用的技能与技能包',
      'action.refresh': '刷新',
      'action.refreshing': '刷新中…',
      'action.retry': '重试',
      'action.viewKey': '查看完整密钥',
      'state.loading': '读取中…',
      'state.failed': '读取失败',
      'state.incomplete': '技能目录读取不完整',
      'status.configured': '已配置',
      'status.missing': '未配置',
      'status.error': '读取失败',
      'card.apiKey': 'API Key',
      'card.loaded': '已加载技能',
      'card.disabled': '未启用',
      'card.context': '当前上下文',
      'card.apiKeyNote': '凭据引用 {ref}',
      'card.loadedNote': '{loaded} 个已加载 / {total} 个已发现',
      'card.disabledNote': '{skills} 个模型禁用技能 · {bundles} 个未启用技能包',
      'card.contextNote': '共 {count} 个预设',
      'context.preset': '预设',
      'context.workspace': '工作区',
      'context.defaultPreset': '默认预设',
      'apiKey.ref': '凭据引用',
      'apiKey.hint': '在「设置 → 模型」中修改；面板每次刷新都会重新读取。',
      'apiKey.missing': '当前没有配置 API Key。',
      'loaded.hint': '这些技能已加载进当前会话的模型技能目录，可由模型调用或通过 / 命令手动调用。',
      'loaded.empty': '当前视角下没有已加载的技能。',
      'disabled.modelHint': 'SKILL.md 中设置了 disable-model-invocation，因此只对用户开放，不入模型目录。',
      'disabled.modelEmpty': '没有模型禁用的技能。',
      'disabled.bundleHint': '以下技能包已随 Harness 提供但当前未启用；在「插件」页打开后，其技能会出现在已加载目录里。',
      'disabled.bundleEmpty': '没有未启用的技能包。',
      'section.modelDisabled': '模型禁用的技能',
      'section.bundles': '未启用的技能包',
      'badge.userOnly': '仅用户可调用',
      'badge.modelOnly': '仅模型可用',
      'badge.notInstalled': '未安装',
      'availability.installation': '可安装',
      'availability.profile': '已安装',
      'availability.missing': '缺失',
      'availability.other': '未启用',
      'source.projectDsh': '项目',
      'source.projectAgents': '项目（agents）',
      'source.custom': '自定义',
      'source.userDsh': '用户',
      'source.userAgents': '用户（agents）',
      'source.runtime': '运行时',
      'source.bundled': '内置',
      'source.other': '其它',
      'footer.updated': '更新于 {time}',
      'session.matrix.title': '本次会话的技能',
      'session.action.all': '全选',
      'session.action.none': '全不选',
      'session.count': '已启用 {enabled} / 共 {total}',
      'session.empty': '当前视角下没有可对模型开放的技能。',
      'session.userOnly': '另有 {count} 个技能只允许用户手动调用，不受这里影响。',
      'session.blankHint': '空白会话：选择立即生效，第一条消息就按这里筛选下发。',
      'session.liveHint': '会话已开始：改动会在下一轮生效（追加一条新的技能目录）。',
      'session.offline': '这个会话当前没有运行中的 agent，无法修改选择。',
      'session.failed': '读取技能目录失败',
      'session.retry': '重试',
      'session.saved': '已保存',
      'session.noSession': '没有可用的会话。',
    };
    const en = {
      panel: 'Skill dashboard',
      title: 'Skill dashboard',
      subtitle: 'API key and skill status',
      'nav.overview': 'Overview',
      'nav.session': 'Session skills',
      'nav.apiKey': 'API key',
      'nav.loaded': 'Loaded skills',
      'nav.disabled': 'Not enabled',
      'view.overview.title': 'Overview',
      'view.overview.sub': 'API key and skill status at a glance',
      'view.session.title': 'Session skills',
      'view.session.sub': 'Choose which skills this session exposes to the model',
      'view.apiKey.title': 'API key',
      'view.apiKey.sub': 'The complete configured credential',
      'view.loaded.title': 'Loaded skills',
      'view.loaded.sub': 'Present in the model skill catalog of this session',
      'view.disabled.title': 'Not enabled',
      'view.disabled.sub': 'Skills and skill bundles that exist but are not enabled',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing…',
      'action.retry': 'Retry',
      'action.viewKey': 'View full key',
      'state.loading': 'Loading…',
      'state.failed': 'Failed to load',
      'state.incomplete': 'Skill discovery is incomplete',
      'status.configured': 'Configured',
      'status.missing': 'Not configured',
      'status.error': 'Failed to read',
      'card.apiKey': 'API key',
      'card.loaded': 'Loaded skills',
      'card.disabled': 'Not enabled',
      'card.context': 'Current context',
      'card.apiKeyNote': 'Credential reference {ref}',
      'card.loadedNote': '{loaded} loaded / {total} discovered',
      'card.disabledNote': '{skills} model-disabled skills · {bundles} disabled skill bundles',
      'card.contextNote': '{count} presets available',
      'context.preset': 'Preset',
      'context.workspace': 'Workspace',
      'context.defaultPreset': 'Default preset',
      'apiKey.ref': 'Credential reference',
      'apiKey.hint': 'Change it in Settings → Models. Every refresh re-reads it.',
      'apiKey.missing': 'No API key is configured.',
      'loaded.hint': 'These skills are in the model skill catalog of this session, callable by the model or with /name.',
      'loaded.empty': 'No loaded skills in the current view.',
      'disabled.modelHint': 'These SKILL.md files set disable-model-invocation, so only people can call them.',
      'disabled.modelEmpty': 'No model-disabled skills.',
      'disabled.bundleHint': 'These skill bundles ship with Harness but are switched off. Enabling them in Plugins adds their skills to the loaded catalog.',
      'disabled.bundleEmpty': 'No disabled skill bundles.',
      'section.modelDisabled': 'Model-disabled skills',
      'section.bundles': 'Disabled skill bundles',
      'badge.userOnly': 'User only',
      'badge.modelOnly': 'Model only',
      'badge.notInstalled': 'Not installed',
      'availability.installation': 'Installable',
      'availability.profile': 'Installed',
      'availability.missing': 'Missing',
      'availability.other': 'Not enabled',
      'source.projectDsh': 'Project',
      'source.projectAgents': 'Project (agents)',
      'source.custom': 'Custom',
      'source.userDsh': 'User',
      'source.userAgents': 'User (agents)',
      'source.runtime': 'Runtime',
      'source.bundled': 'Bundled',
      'source.other': 'Other',
      'footer.updated': 'Updated {time}',
      'session.matrix.title': 'Skills for this session',
      'session.action.all': 'Select all',
      'session.action.none': 'Select none',
      'session.count': '{enabled} of {total} enabled',
      'session.empty': 'No model-visible skills in this view.',
      'session.userOnly': '{count} more skills are user-invocable only and unaffected by this choice.',
      'session.blankHint': 'Blank session: the choice applies immediately to the first message.',
      'session.liveHint': 'Session already started: the change applies on the next turn (a new catalog is appended).',
      'session.offline': 'This session has no live agent, so the choice cannot be changed.',
      'session.failed': 'Failed to read the skill catalog',
      'session.retry': 'Retry',
      'session.saved': 'Saved',
      'session.noSession': 'No session available.',
    };

    /** 技能来源标签的字典 key；未知来源统一落到其它。 */
    const SOURCE_KEYS = {
      'project-dsh': 'source.projectDsh',
      'project-agents': 'source.projectAgents',
      custom: 'source.custom',
      'user-dsh': 'source.userDsh',
      'user-agents': 'source.userAgents',
      runtime: 'source.runtime',
      bundled: 'source.bundled',
    };

    /** 技能包的可用性标签。 */
    const AVAILABILITY_KEYS = {
      installation: 'availability.installation',
      profile: 'availability.profile',
      missing: 'availability.missing',
    };

    /** 用 `{name}` 占位符填值；字典本身保持纯文本，方便后续补语言。 */
    function format(t, key, values) {
      return t(key).replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
    }

    /** 当前浏览器语言，交给 Host 挑选 bundle 标题。 */
    function activeLanguage() {
      try {
        return (typeof navigator !== 'undefined' && navigator.language) || 'en';
      } catch {
        return 'en';
      }
    }

    /**
     * 选出仪表盘要看的那条会话：优先主视图持有（当前打开的会话），否则取最近更新的非子会话。
     * 退而求其次的返回值只依赖 id/cwd/preset，避免每次 store 变更都触发重新请求。
     */
    function selectTarget(state) {
      const rows = Object.values(state.byId);
      if (rows.length === 0) return null;
      const current = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0);
      const fallback = current ?? rows
        .filter(row => row.origin !== 'subagent')
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (fallback === undefined) return null;
      return {
        id: fallback.id,
        cwd: fallback.cwd ?? null,
        preset: fallback.projectionValues?.agentPreset ?? null,
      };
    }

    /** selectTarget 的自定义比较，保持引用稳定。 */
    function sameTarget(left, right) {
      if (left === right) return true;
      if (left === null || right === null) return false;
      return left.id === right.id && left.cwd === right.cwd && left.preset === right.preset;
    }

    /**
     * 拉取 Host 路由的数据；会话工作区 / preset 变化或手动刷新时重取。
     * @param target - selectTarget 的结果。
     * @returns 状态、数据与 refresh 回调。
     */
    function useDashboardData(target) {
      const [state, setState] = useState({ status: 'loading', payload: null, error: null });
      const [revision, setRevision] = useState(0);
      useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        const query = new URLSearchParams();
        if (target?.cwd) query.set('cwd', target.cwd);
        if (target?.preset) query.set('preset', target.preset);
        const language = activeLanguage();
        if (language) query.set('lang', language);
        const search = query.toString();
        setState(previous => previous.payload === null
          ? { status: 'loading', payload: null, error: null }
          : { ...previous, status: 'loading', error: null });
        fetch(`${DATA_ROUTE}${search.length > 0 ? `?${search}` : ''}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
          })
          .then((payload) => {
            if (!alive) return;
            if (payload?.ok === false) throw new Error(String(payload.error ?? 'unknown error'));
            setState({ status: 'ready', payload, error: null });
          })
          .catch((error) => {
            if (!alive || controller.signal.aborted) return;
            setState({ status: 'failed', payload: null, error: String(error?.message ?? error) });
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [target?.cwd, target?.preset, revision]);
      return { ...state, refresh: () => setRevision(value => value + 1) };
    }

    /** 矩阵与输入卡之间的视觉间距：hero 栈自带 32px 底距，这里只补到约 12px。 */
    const MATRIX_RESERVE_GAP = 20;

    /**
     * 把矩阵的实际高度写成滚动区的底部留白。
     * 为什么：hero 阶段的输入卡是在滚动区里垂直居中的，矩阵绝对定位在卡片下方、不占流；
     * 只有让滚动区按矩阵高度预留底部空间，"标题 + 输入卡 + 矩阵"才会作为一个整体居中，
     * 等于把原来孤零零的 hero 整块往上抬了矩阵高度的一半（这正是"整体往上移"）。
     * 用 `useLayoutEffect`：在浏览器绘制前就写好留白，避免首帧先居中、再跳上去。
     * 依赖两个稳定的 data 属性：`data-conversation-scroll`（滚动区）与 `data-content-phase`（阶段）。
     * @param ref - 矩阵根节点。
     */
    function useHeroMatrixReserve(ref) {
      useLayoutEffect(() => {
        const matrix = ref.current;
        if (!matrix || typeof matrix.closest !== 'function' || typeof ResizeObserver !== 'function') return undefined;
        const scroller = matrix.closest('[data-conversation-scroll]');
        if (!scroller) return undefined;
        const sync = () => {
          const height = Math.round(matrix.getBoundingClientRect().height);
          // 极矮的窗口里不要把 hero 压到不可用：留白最多吃掉滚动区高度减一个 hero。
          const cap = Math.max(96, scroller.clientHeight - 220);
          scroller.style.setProperty('--sksp-matrix-reserve', `${Math.min(height + MATRIX_RESERVE_GAP, cap)}px`);
        };
        sync();
        const observer = new ResizeObserver(sync);
        // 矩阵高度随列数变，滚动区高度随窗口变，两者都触发重算。
        observer.observe(matrix);
        observer.observe(scroller);
        return () => {
          observer.disconnect();
          scroller.style.removeProperty('--sksp-matrix-reserve');
        };
      }, [ref]);
    }

    /**
     * 一次"会话技能"读取 + 提交。提交走乐观更新：先改本地选择再 POST，失败回滚。
     * @param sessionId - 目标会话。
     * @returns 状态、数据、commit 与 refresh。
     */
    function useSessionSkills(sessionId) {
      const [state, setState] = useState({ status: 'idle', data: null, error: null, pending: false, notice: null, revision: 0 });
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
        let alive = true;
        const controller = new AbortController();
        setState(previous => ({ ...previous, status: previous.data === null ? 'loading' : 'refreshing', error: null }));
        fetch(`${SESSION_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload?.ok === false) throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
            return payload;
          })
          .then((payload) => {
            if (!alive) return;
            setState(previous => ({ ...previous, status: 'ready', data: payload, error: null }));
          })
          .catch((error) => {
            if (!alive || controller.signal.aborted) return;
            setState(previous => ({ ...previous, status: 'failed', error: String(error?.message ?? error) }));
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [sessionId, state.revision]);

      /** 提交一次选择；Host 拒绝时把选择回滚到提交前。 */
      function commit(next) {
        const data = state.data;
        if (data === null || state.pending) return;
        const previous = data.selection;
        setState(current => ({
          ...current,
          pending: true,
          error: null,
          notice: null,
          data: { ...current.data, selection: next },
        }));
        fetch(SESSION_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId, ...next }),
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload?.ok === false) throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
            return payload;
          })
          .then((payload) => {
            setState(current => ({
              ...current,
              pending: false,
              notice: payload.applied === 'next-step' ? 'next-step' : 'session-start',
              data: current.data === null ? current.data : { ...current.data, selection: payload.selection },
            }));
          })
          .catch((error) => {
            setState(current => ({
              ...current,
              pending: false,
              error: String(error?.message ?? error),
              data: current.data === null ? current.data : { ...current.data, selection: previous },
            }));
          });
      }

      return {
        ...state,
        commit,
        refresh: () => setState(current => ({ ...current, revision: current.revision + 1 })),
      };
    }

    /** 从一次读取结果算出可选集、启用集与计数。 */
    function selectionSummary(data) {
      const items = data?.skills?.items ?? [];
      const selectable = items.filter(skill => skill.modelInvocable);
      const total = selectable.length;
      const names = data?.selection?.mode === 'set' ? new Set(data.selection.names) : null;
      const enabledNames = names === null
        ? selectable.map(skill => skill.name)
        : selectable.filter(skill => names.has(skill.name)).map(skill => skill.name);
      return {
        selectable,
        total,
        all: names === null,
        enabledNames,
        enabled: enabledNames.length,
        userOnly: items.length - total,
      };
    }

    /** 勾选/取消勾选后应有的名字集合。 */
    function nextNamesAfterToggle(summary, name) {
      return summary.enabledNames.includes(name)
        ? summary.enabledNames.filter(candidate => candidate !== name)
        : [...summary.enabledNames, name];
    }

    /** 会话技能：清单图标。 */
    function IconList({ size }) {
      return h(Icon, { size },
        h('path', { d: 'M4 6h16' }),
        h('path', { d: 'M4 12h16' }),
        h('path', { d: 'M4 18h10' }));
    }

    /** 已启用：矩阵方块里的对号。 */
    function IconCheck({ size }) {
      return h(Icon, { size }, h('path', { d: 'M4.5 12.5 9.5 17.5 19.5 6.5' }));
    }

    /** 一个技能的可勾选行。 */
    function SkillToggleRow({ t, skill, checked, disabled, onChange }) {
      const sourceKey = SOURCE_KEYS[skill.source] ?? 'source.other';
      return h('label', { className: `sksp-row${checked ? ' is-on' : ''}` },
        h('input', {
          type: 'checkbox',
          className: 'sksp-check',
          checked,
          disabled,
          onChange,
        }),
        h('span', { className: 'sksp-row-text' },
          h('span', { className: 'sksp-row-head' },
            h('span', { className: 'sksp-name' }, skill.name),
            h('span', { className: 'sksp-badge' }, t(sourceKey))),
          h('span', { className: 'sksp-desc' }, skill.description)));
    }

    /** 技能勾选列表 + 计数与全选/全不选；仪表盘的「会话技能」视图使用。 */
    function SkillToggleList({ t, data, pending, onCommit }) {
      const summary = selectionSummary(data);
      const busy = pending === true;
      return h('div', { className: 'sksp-body' },
        h('div', { className: 'sksp-toolbar' },
          h('span', { className: 'sksp-count' }, format(t, 'session.count', { enabled: summary.enabled, total: summary.total })),
          h('div', { className: 'sksp-toolbar-actions' },
            h('button', {
              type: 'button',
              className: 'sksp-btn',
              disabled: busy || summary.all,
              onClick: () => onCommit({ mode: 'all' }),
            }, t('session.action.all')),
            h('button', {
              type: 'button',
              className: 'sksp-btn',
              disabled: busy || summary.enabled === 0,
              onClick: () => onCommit({ mode: 'set', names: [] }),
            }, t('session.action.none')))),
        summary.selectable.length === 0
          ? h('p', { className: 'sksp-empty' }, t('session.empty'))
          : h('div', { className: 'sksp-list' }, summary.selectable.map(skill => h(SkillToggleRow, {
            key: skill.name,
            t,
            skill,
            checked: summary.all || summary.enabledNames.includes(skill.name),
            disabled: busy,
            onChange: () => onCommit({ mode: 'set', names: nextNamesAfterToggle(summary, skill.name) }),
          }))),
        summary.userOnly > 0
          ? h('p', { className: 'sksp-hint' }, format(t, 'session.userOnly', { count: summary.userOnly }))
          : null);
    }

    /** 一个技能方块：点一下切换"本次会话是否对模型开放"。 */
    function SkillTile({ t, skill, checked, disabled, onToggle }) {
      const sourceKey = SOURCE_KEYS[skill.source] ?? 'source.other';
      return h('button', {
        type: 'button',
        className: `sksp-tile${checked ? ' is-on' : ''}`,
        'aria-pressed': checked,
        title: `${skill.name}\n${skill.description ?? ''}`,
        disabled,
        onClick: onToggle,
      },
      h('span', { className: 'sksp-tile-mark', 'aria-hidden': true },
        checked ? h(IconCheck, { size: 12 }) : null),
      h('span', { className: 'sksp-tile-body' },
        h('span', { className: 'sksp-tile-head' },
          h('span', { className: 'sksp-tile-name' }, skill.name),
          h('span', { className: 'sksp-badge' }, t(sourceKey))),
        h('span', { className: 'sksp-tile-desc' }, skill.description ?? '')));
    }

    /**
     * 新建会话页内嵌的技能矩阵：不再点开浮层，整页直接列出可点选的技能。
     * 未启用的技能不会进入模型目录，也调用不到（Host 侧裁剪目录正文 + skill guard 硬拒）。
     * @param props - session 级槽位标准 props（sessionId）与注册时的 inject 面（sessionIdFromSlot）。
     */
    function SessionSkillMatrix(props) {
      const { t } = props;
      // 会话 id 有两个来源：框架给 session 级槽位的标准 props，以及注册时的 inject 面。
      // 两个都收，谁先到用谁，避免依赖其中一条具体实现路径。
      const sessionId = props.sessionIdFromSlot ?? props.sessionId;
      const skills = useSessionSkills(sessionId);
      const matrixRef = useRef(null);
      useHeroMatrixReserve(matrixRef);
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      const data = skills.data;
      const summary = selectionSummary(data);
      const busy = skills.pending === true;
      const hint = data === null
        ? null
        : data.session?.live === false
          ? t('session.offline')
          : data.session?.published === true ? t('session.liveHint') : t('session.blankHint');
      // 勾回全集就收敛成 mode:'all'，不留一份等于全集的名字清单。
      const commitNames = names => (names.length >= summary.total
        ? skills.commit({ mode: 'all' })
        : skills.commit({ mode: 'set', names }));
      return h('div', { className: 'sksp-matrix', ref: matrixRef },
        h('style', { dangerouslySetInnerHTML: { __html: SESSION_STYLE } }),
        h('div', { className: 'sksp-matrix-head' },
          h('div', { className: 'sksp-matrix-titles' },
            h('span', { className: 'sksp-matrix-title' }, t('session.matrix.title')),
            data === null
              ? null
              : h('span', { className: 'sksp-matrix-count' },
                format(t, 'session.count', { enabled: summary.enabled, total: summary.total }))),
          data === null
            ? null
            : h('div', { className: 'sksp-matrix-actions' },
              h('button', {
                type: 'button',
                className: 'sksp-btn',
                disabled: busy || summary.all,
                onClick: () => skills.commit({ mode: 'all' }),
              }, t('session.action.all')),
              h('button', {
                type: 'button',
                className: 'sksp-btn',
                disabled: busy || summary.enabled === 0,
                onClick: () => skills.commit({ mode: 'set', names: [] }),
              }, t('session.action.none')))),
        data === null
          ? h('p', { className: 'sksp-matrix-status' },
            skills.status === 'failed'
              ? h(React.Fragment, null,
                h('span', { className: 'sksp-error' }, `${t('session.failed')}: ${skills.error}`),
                ' ',
                h('button', { type: 'button', className: 'sksp-btn', onClick: skills.refresh },
                  t('session.retry')))
              : t('state.loading'))
          : summary.selectable.length === 0
            ? h('p', { className: 'sksp-empty' }, t('session.empty'))
            : h('div', { className: 'sksp-grid' }, summary.selectable.map(skill => h(SkillTile, {
              key: skill.name,
              t,
              skill,
              checked: summary.all || summary.enabledNames.includes(skill.name),
              disabled: busy,
              onToggle: () => commitNames(nextNamesAfterToggle(summary, skill.name)),
            }))),
        h('p', { className: 'sksp-matrix-foot' },
          hint === null ? null : h('span', null, hint),
          summary.userOnly > 0
            ? h('span', null, format(t, 'session.userOnly', { count: summary.userOnly }))
            : null,
          skills.notice === null ? null : h('span', { className: 'sksp-saved' }, t('session.saved')),
          skills.error === null || data === null
            ? null
            : h('span', { className: 'sksp-error' }, skills.error)));
    }

    /** 仪表盘里的「会话技能」视图：同一个列表，直接作用于当前会话。 */
    function SessionSkillPanel({ sessionId, t }) {
      const skills = useSessionSkills(sessionId);
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return h(Empty, null, t('session.noSession'));
      }
      if (skills.data === null) {
        return skills.status === 'failed'
          ? h(Empty, null,
            h('span', { className: 'skd-error' }, skills.error ?? t('session.failed')),
            ' ',
            h(LinkButton, { onClick: skills.refresh }, t('session.retry')))
          : h(Empty, null, t('state.loading'));
      }
      return h(React.Fragment, null,
        h('style', { dangerouslySetInnerHTML: { __html: SESSION_STYLE } }),
        skills.data.session?.published === true
          ? h('p', { className: 'skd-hint' }, t('session.liveHint'))
          : h('p', { className: 'skd-hint' }, t('session.blankHint')),
        h(SkillToggleList, {
          t,
          data: skills.data,
          pending: skills.pending,
          onCommit: (next) => skills.commit(next),
        }),
        skills.error === null ? null : h('p', { className: 'skd-error' }, skills.error));
    }

    /** 统一的小图标外壳：细线、跟随主题前景色。 */
    function Icon({ size = 16, children }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      }, children);
    }

    /** 仪表盘/概览：半圆刻度盘加指针。 */
    function IconGauge({ size }) {
      return h(Icon, { size },
        h('path', { d: 'M4 18a8 8 0 1 1 16 0' }),
        h('path', { d: 'M12 14.5 15.5 10' }),
        h('circle', { cx: 12, cy: 14.5, r: 1.4 }));
    }

    /** 密钥。 */
    function IconKey({ size }) {
      return h(Icon, { size },
        h('circle', { cx: 8.5, cy: 12, r: 3.5 }),
        h('path', { d: 'M12 12h8.5' }),
        h('path', { d: 'M17 12v3.5' }));
    }

    /** 已加载技能：清单加勾。 */
    function IconChecklist({ size }) {
      return h(Icon, { size },
        h('path', { d: 'M4 7h10' }),
        h('path', { d: 'M4 12h10' }),
        h('path', { d: 'M4 17h6' }),
        h('path', { d: 'm16.5 16 2 2 3-4' }));
    }

    /** 未启用：电源符号。 */
    function IconPower({ size }) {
      return h(Icon, { size },
        h('path', { d: 'M12 4v7' }),
        h('path', { d: 'M7.6 7.2a7 7 0 1 0 8.8 0' }));
    }

    /** 刷新：环形箭头。 */
    function IconRefresh({ size }) {
      return h(Icon, { size },
        h('path', { d: 'M20 11a8 8 0 1 0-2.4 5.7' }),
        h('path', { d: 'M20 5v6h-6' }));
    }

    /** 状态圆点。 */
    function StatusDot({ tone }) {
      return h('span', { className: `skd-dot is-${tone}`, 'aria-hidden': true });
    }

    /** 一张概览卡片：小标题 + 内容。 */
    function Card({ label, children }) {
      return h('div', { className: 'skd-card' },
        h('div', { className: 'skd-card-label' }, label),
        children);
    }

    /** 文本按钮（链接样式）。 */
    function LinkButton({ children, onClick }) {
      return h('button', { type: 'button', className: 'skd-link', onClick }, children);
    }

    /** 技能行：名称、徽标、描述、指令文件路径。 */
    function SkillRow({ t, skill }) {
      const sourceKey = SOURCE_KEYS[skill.source] ?? 'source.other';
      return h('div', { className: 'skd-skill' },
        h('div', { className: 'skd-skill-head' },
          h('span', { className: 'skd-skill-name' }, skill.name),
          h('span', { className: 'skd-badge' }, t(sourceKey)),
          skill.modelInvocable ? null : h('span', { className: 'skd-badge is-warn' }, t('badge.userOnly')),
          skill.userInvocable ? null : h('span', { className: 'skd-badge is-brand' }, t('badge.modelOnly'))),
        h('p', { className: 'skd-skill-desc' }, skill.description),
        skill.path === null ? null : h('code', { className: 'skd-skill-path', title: skill.path }, skill.path));
    }

    /** 技能包行：标题、可用性、提供的模块列表。 */
    function BundleRow({ t, bundle }) {
      const availabilityKey = AVAILABILITY_KEYS[bundle.availability] ?? 'availability.other';
      return h('div', { className: 'skd-skill' },
        h('div', { className: 'skd-skill-head' },
          h('span', { className: 'skd-skill-name' }, bundle.title),
          h('span', { className: 'skd-badge is-warn' }, t(availabilityKey)),
          bundle.installed ? null : h('span', { className: 'skd-badge' }, t('badge.notInstalled'))),
        bundle.description === null ? null : h('p', { className: 'skd-skill-desc' }, bundle.description),
        h('code', { className: 'skd-skill-path' }, bundle.modules.join('  ')));
    }

    /** 空状态卡片。 */
    function Empty({ children }) {
      return h('div', { className: 'skd-empty' }, children);
    }

    /** 仪表盘页：内部左侧导航 + 内容区。 */
    function Dashboard(props) {
      const { t, useSessions } = props;
      const target = useSessions(selectTarget, sameTarget);
      const data = useDashboardData(target);
      const [view, setView] = useState('overview');
      const payload = data.payload;
      const context = payload?.context ?? null;
      const skills = payload?.skills?.items ?? [];
      const loaded = useMemo(() => skills.filter(skill => skill.modelInvocable), [skills]);
      const modelDisabled = useMemo(() => skills.filter(skill => !skill.modelInvocable), [skills]);
      const bundles = payload?.disabledSkillBundles ?? [];
      const disabledCount = modelDisabled.length + bundles.length;
      const refreshing = data.status === 'loading' && payload !== null;
      const apiKey = payload?.apiKey ?? null;

      const navItems = [
        { id: 'overview', icon: IconGauge, label: t('nav.overview') },
        { id: 'session', icon: IconList, label: t('nav.session') },
        { id: 'apiKey', icon: IconKey, label: t('nav.apiKey') },
        { id: 'loaded', icon: IconChecklist, label: t('nav.loaded'), count: loaded.length },
        { id: 'disabled', icon: IconPower, label: t('nav.disabled'), count: disabledCount },
      ];

      const viewTitles = {
        overview: ['view.overview.title', 'view.overview.sub'],
        session: ['view.session.title', 'view.session.sub'],
        apiKey: ['view.apiKey.title', 'view.apiKey.sub'],
        loaded: ['view.loaded.title', 'view.loaded.sub'],
        disabled: ['view.disabled.title', 'view.disabled.sub'],
      };
      const [titleKey, subtitleKey] = viewTitles[view];

      const apiKeyTone = apiKey === null
        ? 'idle'
        : apiKey.error !== null
          ? 'error'
          : apiKey.value !== null
            ? 'ok'
            : 'warn';
      const apiKeyStatus = apiKeyTone === 'ok'
        ? t('status.configured')
        : apiKeyTone === 'warn'
          ? t('status.missing')
          : apiKeyTone === 'error'
            ? t('status.error')
            : t('state.loading');

      /** 概览：四张卡片。 */
      const renderOverview = () => h('div', { className: 'skd-cards' },
        h(Card, { label: t('card.apiKey') },
          h('div', { className: 'skd-status-row' }, h(StatusDot, { tone: apiKeyTone }), h('span', { className: 'skd-status-text' }, apiKeyStatus)),
          apiKey === null ? null : h('div', { className: 'skd-card-note skd-mono' }, format(t, 'card.apiKeyNote', { ref: apiKey.ref })),
          apiKey?.error === null || apiKey?.error === undefined ? null : h('div', { className: 'skd-card-note skd-error' }, apiKey.error),
          h(LinkButton, { onClick: () => setView('apiKey') }, t('action.viewKey'))),
        h(Card, { label: t('card.loaded') },
          h('div', { className: 'skd-card-value' }, String(loaded.length)),
          h('div', { className: 'skd-card-note' }, format(t, 'card.loadedNote', { loaded: loaded.length, total: skills.length })),
          h(LinkButton, { onClick: () => setView('loaded') }, t('nav.loaded'))),
        h(Card, { label: t('card.disabled') },
          h('div', { className: 'skd-card-value' }, String(modelDisabled.length)),
          h('div', { className: 'skd-card-note' }, format(t, 'card.disabledNote', { skills: modelDisabled.length, bundles: bundles.length })),
          h(LinkButton, { onClick: () => setView('disabled') }, t('nav.disabled'))),
        h(Card, { label: t('card.context') },
          h('div', { className: 'skd-card-value skd-mono' }, context?.preset ?? '—'),
          context === null ? null : h('div', { className: 'skd-card-note skd-mono skd-clip', title: context.cwd }, context.cwd),
          context === null ? null : h('div', { className: 'skd-card-note' }, format(t, 'card.contextNote', { count: context.presets.length }))));

      /** API Key：完整明文密钥。 */
      const renderApiKey = () => h('section', null,
        apiKey === null
          ? h(Empty, null, t('state.loading'))
          : h(React.Fragment, null,
            h('div', { className: 'skd-status-row' },
              h(StatusDot, { tone: apiKeyTone }),
              h('span', { className: 'skd-status-text' }, apiKeyStatus),
              h('span', { className: 'skd-badge skd-mono' }, `${t('apiKey.ref')}: ${apiKey.ref}`)),
            apiKey.value === null
              ? h(Empty, null, t('apiKey.missing'))
              : h('code', { className: 'skd-key-box' }, apiKey.value),
            apiKey.error === null ? null : h('p', { className: 'skd-error' }, apiKey.error),
            h('p', { className: 'skd-hint' }, t('apiKey.hint'))));

      /** 已加载技能列表。 */
      const renderLoaded = () => h('section', null,
        h('p', { className: 'skd-hint' }, payload === null || payload.skills.complete
          ? t('loaded.hint')
          : `${t('loaded.hint')}（${t('state.incomplete')}）`),
        loaded.length === 0
          ? h(Empty, null, t('loaded.empty'))
          : h('div', { className: 'skd-list' }, loaded.map(skill => h(SkillRow, { key: skill.name, t, skill }))));

      /** 未启用：模型禁用技能 + 未启用的技能包。 */
      const renderDisabled = () => h('section', null,
        h('h2', { className: 'skd-section-title' },
          t('section.modelDisabled'),
          h('span', { className: 'skd-count' }, String(modelDisabled.length))),
        h('p', { className: 'skd-hint' }, t('disabled.modelHint')),
        modelDisabled.length === 0
          ? h(Empty, null, t('disabled.modelEmpty'))
          : h('div', { className: 'skd-list' }, modelDisabled.map(skill => h(SkillRow, { key: skill.name, t, skill }))),
        h('h2', { className: 'skd-section-title is-separated' },
          t('section.bundles'),
          h('span', { className: 'skd-count' }, String(bundles.length))),
        h('p', { className: 'skd-hint' }, t('disabled.bundleHint')),
        bundles.length === 0
          ? h(Empty, null, t('disabled.bundleEmpty'))
          : h('div', { className: 'skd-list' }, bundles.map(bundle => h(BundleRow, { key: bundle.name, t, bundle }))));

      const renderBody = () => {
        if (payload === null) {
          return data.status === 'failed'
            ? h(Empty, null,
              h('span', { className: 'skd-error' }, data.error ?? t('state.failed')),
              ' ',
              h(LinkButton, { onClick: data.refresh }, t('action.retry')))
            : h(Empty, null, t('state.loading'));
        }
        if (view === 'apiKey') return renderApiKey();
        if (view === 'session') return h(SessionSkillPanel, { sessionId: target?.id, t });
        if (view === 'loaded') return renderLoaded();
        if (view === 'disabled') return renderDisabled();
        return renderOverview();
      };

      return h('div', { className: 'skd-page' },
        h('style', { dangerouslySetInnerHTML: { __html: STYLE } }),
        h('aside', { className: 'skd-nav' },
          h('div', { className: 'skd-brand' },
            h('span', { className: 'skd-brand-mark' }, h(IconGauge, { size: 18 })),
            h('div', { className: 'skd-brand-text' },
              h('div', { className: 'skd-brand-title' }, t('title')),
              h('div', { className: 'skd-brand-sub' }, t('subtitle')))),
          h('nav', { className: 'skd-nav-list' }, navItems.map(item => h('button', {
            key: item.id,
            type: 'button',
            className: `skd-nav-item${view === item.id ? ' is-active' : ''}`,
            'aria-current': view === item.id ? 'page' : undefined,
            onClick: () => setView(item.id),
          },
          h('span', { className: 'skd-nav-icon' }, h(item.icon, { size: 16 })),
          h('span', { className: 'skd-nav-label' }, item.label),
          item.count === undefined ? null : h('span', { className: 'skd-nav-count' }, String(item.count))))),
          payload === null ? null : h('div', { className: 'skd-nav-foot' }, format(t, 'footer.updated', {
            time: new Date(payload.fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          }))),
        h('main', { className: 'skd-main' },
          h('header', { className: 'skd-head' },
            h('div', null,
              h('h1', { className: 'skd-title' }, t(titleKey)),
              h('p', { className: 'skd-sub' }, t(subtitleKey))),
            h('div', { className: 'skd-actions' },
              context === null ? null : h('span', { className: 'skd-chip', title: t('context.preset') }, `${t('context.preset')} · ${context.preset ?? '—'}`),
              h('button', {
                type: 'button',
                className: 'skd-button',
                onClick: data.refresh,
                disabled: refreshing,
              }, refreshing ? t('action.refreshing') : t('action.refresh')))),
          h('div', { className: 'skd-body' }, renderBody())));
    }

    /** 侧栏图标：一块带指针的仪表盘。 */
    function SidebarIcon({ size }) {
      return h(IconGauge, { size });
    }

    /** 组件内样式：颜色只用主题 token，深浅主题自动跟随。 */
    const STYLE = `
.skd-page {
  box-sizing: border-box;
  display: flex;
  height: 100%;
  min-height: 100%;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.skd-nav {
  box-sizing: border-box;
  display: flex;
  flex: 0 0 212px;
  flex-direction: column;
  gap: 2px;
  width: 212px;
  padding: 20px 12px 16px;
  border-right: 1px solid var(--dsw-alias-border-l1);
  overflow: auto;
}
.skd-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 8px 18px;
}
.skd-brand-mark {
  display: grid;
  flex: none;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-brand-primary);
}
.skd-brand-text { min-width: 0; }
.skd-brand-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.skd-brand-sub {
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skd-nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.skd-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.skd-nav-item:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.skd-nav-item:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.skd-nav-item.is-active {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.skd-nav-icon {
  display: inline-flex;
  flex: none;
  opacity: .85;
}
.skd-nav-label { min-width: 0; }
.skd-nav-count {
  margin-left: auto;
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  text-align: center;
}
.skd-nav-item.is-active .skd-nav-count { color: var(--dsw-alias-brand-primary); }
.skd-nav-foot {
  margin-top: auto;
  padding: 16px 10px 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
}
.skd-main {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  padding: 26px clamp(20px, 3vw, 40px) 40px;
  overflow: auto;
}
.skd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.skd-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
}
.skd-sub {
  margin: 3px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 18px;
}
.skd-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}
.skd-chip {
  max-width: 260px;
  overflow: hidden;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.skd-button {
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.skd-button:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.skd-button:disabled {
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
.skd-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.skd-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.skd-card-label {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.skd-card-value {
  font-size: 24px;
  font-weight: 600;
  line-height: 30px;
  font-variant-numeric: tabular-nums;
}
.skd-card-value.skd-mono { font-size: 18px; line-height: 26px; }
.skd-card-note {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 17px;
}
.skd-clip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skd-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.skd-status-text { font-weight: 600; }
.skd-dot {
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--dsw-alias-state-idle-primary);
}
.skd-dot.is-ok { background: var(--dsw-alias-state-success-primary); }
.skd-dot.is-warn { background: var(--dsw-alias-state-warn-primary); }
.skd-dot.is-error { background: var(--dsw-alias-state-error-primary); }
.skd-dot.is-idle { background: var(--dsw-alias-state-idle-primary); }
.skd-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.skd-link:hover { text-decoration: underline; }
.skd-mono { font-family: ${MONO_FONT}; }
.skd-hint {
  margin: 0 0 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.skd-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}
.skd-section-title.is-separated { margin-top: 26px; }
.skd-count {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 500;
}
.skd-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.skd-skill {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.skd-skill-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.skd-skill-name {
  font-family: ${MONO_FONT};
  font-size: 13px;
  font-weight: 600;
}
.skd-skill-desc {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}
.skd-skill-path {
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-family: ${MONO_FONT};
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skd-badge {
  padding: 1px 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.skd-badge.is-brand { color: var(--dsw-alias-brand-primary); }
.skd-badge.is-warn { color: var(--dsw-alias-state-warn-primary); }
.skd-key-box {
  display: block;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  font-family: ${MONO_FONT};
  font-size: 15px;
  line-height: 24px;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: all;
}
.skd-empty {
  padding: 20px;
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}
.skd-error { color: var(--dsw-alias-state-error-primary); }
@media (max-width: 680px) {
  .skd-page { flex-direction: column; }
  .skd-nav {
    flex: none;
    width: auto;
    flex-direction: row;
    gap: 4px;
    padding: 10px 12px;
    border-right: 0;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
    overflow-x: auto;
  }
  .skd-brand, .skd-nav-foot { display: none; }
  .skd-nav-item { width: auto; white-space: nowrap; }
}
`;

    /** 会话技能矩阵的样式；与仪表盘分开一套前缀，避免两个页面互相影响。 */
    const SESSION_STYLE = `
/* 新建会话页的整页布局：矩阵挂在输入卡下方，滚动区按矩阵高度留出底部空间，
   让"标题 + 输入卡 + 矩阵"作为一个整体居中（等于把原来的 hero 往上抬）。 */
[data-conversation-content][data-content-phase='hero'] [data-conversation-scroll] {
  /* 这个 shell 没有全局 border-box：不写明的话 padding 会把滚动区整体撑高，而不是让内容区变矮。 */
  box-sizing: border-box;
  padding-bottom: var(--sksp-matrix-reserve, 0px);
}
/* 矩阵的定位基准：hero 栈（其中含输入卡）。 */
[data-content-phase='hero'] [data-composer-seat] {
  position: relative;
}
.sksp-matrix {
  box-sizing: border-box;
  position: absolute;
  /* hero 栈自带 32px 底距（上游 .composerHero 的 padding-bottom），这里收回到约 12px 的视觉间距。 */
  top: calc(100% - 20px);
  left: 0;
  right: 0;
  /* 与输入卡同宽：卡片宽度是 hero 栈减去两侧 clearance；左右各留 auto 外边距即居中。 */
  width: min(
    var(--dsh-composer-card-max-width, 832px),
    calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))
  );
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--dsw-alias-label-primary);
}
.sksp-matrix-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.sksp-matrix-titles {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.sksp-matrix-title {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 18px;
}
.sksp-matrix-count {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.sksp-matrix-actions {
  display: flex;
  flex: none;
  gap: 6px;
}
.sksp-grid {
  display: grid;
  /* auto-fill：技能少时不把方块拉宽；列宽下限 186px，宽屏一行最多四列。 */
  grid-template-columns: repeat(auto-fill, minmax(186px, 1fr));
  gap: 8px;
  max-height: min(46vh, 380px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1px;
}
.sksp-tile {
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.sksp-tile:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.sksp-tile:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.sksp-tile:disabled {
  cursor: default;
}
.sksp-tile.is-on {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 48%, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
}
.sksp-tile.is-on:hover {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
}
.sksp-tile-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 5px;
  color: var(--dsw-alias-label-on-color);
}
.sksp-tile.is-on .sksp-tile-mark {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary);
}
.sksp-tile-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}
.sksp-tile-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sksp-tile-name {
  overflow: hidden;
  font-family: ${MONO_FONT};
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sksp-tile-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 16px;
}
.sksp-matrix-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
}
.sksp-matrix-status {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
@media (max-width: 640px) {
  .sksp-matrix-head { flex-wrap: wrap; }
  .sksp-grid { max-height: min(42vh, 320px); }
}
.sksp-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 4px 20px 0;
  overflow: auto;
}
.sksp-toolbar {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0 6px;
  background: var(--dsw-alias-bg-base);
}
.sksp-count {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.sksp-toolbar-actions {
  display: flex;
  gap: 6px;
}
.sksp-btn {
  padding: 3px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.sksp-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.sksp-btn:disabled {
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
.sksp-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 4px;
}
.sksp-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
}
.sksp-row:hover { background: var(--dsw-alias-bg-layer-2); }
.sksp-check {
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 2px;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.sksp-row-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.sksp-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sksp-name {
  font-family: ${MONO_FONT};
  font-size: 13px;
  font-weight: 600;
}
.sksp-desc {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.sksp-badge {
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.sksp-hint {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 17px;
}
.sksp-empty {
  margin: 0;
  padding: 18px;
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.sksp-error {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
  word-break: break-word;
}
.sksp-saved { color: var(--dsw-alias-state-success-primary); }
`;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skill-dashboard: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Dashboard));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel'),
        }, SidebarIcon));
        // 只在空白会话出现的选项位：props 直接给 sessionId，正是"新建会话"的时间窗。
        // 矩阵由组件自己绝对定位到输入卡下方（见 SESSION_STYLE 的表头注释），这里只占一个零高度的位置。
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: `${PANEL_ID}.session-skills`,
          order: 10,
          locale: NS,
          inject: (sessionId) => ({ sessionIdFromSlot: sessionId ?? null }),
        }, SessionSkillMatrix));
      },
    };
  },
});
