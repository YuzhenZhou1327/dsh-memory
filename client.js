/**
 * dsh-memory — 浏览器侧插件
 *
 * 侧边栏「记忆」面板：查看、编辑跨项目记忆（D:\dsh\MEMORY.md）与每个工作区项目的项目记忆（dsh.md）。
 * 数据走主机侧插件自带的 HTTP 路由 /api/dsh-memory/*，不依赖任何 @deepseek-ai/dsh-client-ui-* 包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-memory'
    const PANEL_ID = 'memory'
    const PANEL_ORDER = 30
    const API_STATE = 'api/dsh-memory/live/state'
    const API_WRITE = 'api/dsh-memory/live/write'

    const DICTS = {
      zh: {
        'entry.label': '记忆',
        'page.title': '记忆',
        'page.refresh': '刷新',
        'page.global': '跨项目记忆',
        'page.projects': '项目记忆',
        'page.save': '保存',
        'page.saving': '保存中…',
        'page.characters': '字符',
        'page.loading': '正在加载…',
        'page.empty': '（空，尚未写入）',
        'page.missing': '文件还未创建',
        'page.exists': '已存在',
        'page.over': '超出上限，请先压缩内容再保存',
        'page.defaultWorkspace': '默认工作目录，不启用项目记忆',
        'page.saved': '已保存',
        'page.noWorkspace': '工作区里还没有项目',
        'page.hint': '记忆会在会话开始时、以及每次上下文压缩之后自动注入。超过上限时写入会被拒绝，需要先压缩存量内容。',
        'page.error': '读取失败',
        'page.dirty': '有未保存的修改',
        'page.unsaved': '未保存'
      },
      en: {
        'entry.label': 'Memory',
        'page.title': 'Memory',
        'page.refresh': 'Refresh',
        'page.global': 'Cross-project memory',
        'page.projects': 'Project memory',
        'page.save': 'Save',
        'page.saving': 'Saving…',
        'page.characters': 'chars',
        'page.loading': 'Loading…',
        'page.empty': '(empty, nothing written yet)',
        'page.missing': 'File not created yet',
        'page.exists': 'exists',
        'page.over': 'Over the limit — compress the content first',
        'page.defaultWorkspace': 'Default workspace — project memory disabled',
        'page.saved': 'Saved',
        'page.noWorkspace': 'No projects in the workspace yet',
        'page.hint': 'Memory is injected at session start and after every context compaction. Writes above the limit are rejected; compress the existing content first.',
        'page.error': 'Failed to load',
        'page.dirty': 'Unsaved changes',
        'page.unsaved': 'unsaved'
      }
    }

    /** locale service 绑定后的翻译函数；apply 之前退化为中文词典。 */
    let tt = (key) => DICTS.zh[key] ?? key

    // ------------------------------------------------------------------ 样式
    const S = {
      root: {
        display: 'flex',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.5
      },
      aside: {
        flex: '0 0 236px',
        width: 236,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '10px 8px',
        boxSizing: 'border-box',
        borderRight: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-specific-sidebar-fill)',
        overflowY: 'auto'
      },
      asideHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 6px 6px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        letterSpacing: '0.04em',
        textTransform: 'uppercase'
      },
      sectionLabel: {
        padding: '10px 6px 4px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        letterSpacing: '0.04em',
        textTransform: 'uppercase'
      },
      item: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        borderRadius: 8,
        padding: '6px 8px',
        cursor: 'pointer'
      },
      itemActive: {
        background: 'var(--dsw-alias-bg-layer-2)',
        borderColor: 'var(--dsw-alias-border-l2)'
      },
      itemTitle: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      itemMeta: {
        display: 'block',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      main: {
        flex: '1 1 auto',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '14px 16px',
        boxSizing: 'border-box',
        gap: 10
      },
      headRow: { display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      path: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
        flex: '1 1 auto'
      },
      counter: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      counterOver: { color: 'var(--dsw-alias-state-error-primary)' },
      textarea: {
        flex: '1 1 auto',
        minHeight: 160,
        width: '100%',
        boxSizing: 'border-box',
        resize: 'none',
        padding: 10,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.6,
        outline: 'none'
      },
      footer: { display: 'flex', alignItems: 'center', gap: 10 },
      hint: { flex: '1 1 auto', color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
      notice: { fontSize: 11 },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        borderRadius: 7,
        padding: '5px 12px',
        cursor: 'pointer'
      },
      buttonPrimary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        font: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 7,
        padding: '5px 14px',
        cursor: 'pointer'
      },
      disabled: { opacity: 0.45, cursor: 'not-allowed' },
      banner: { padding: '6px 10px', borderRadius: 7, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
    }

    function merge(...parts) {
      return Object.assign({}, ...parts.filter(Boolean))
    }

    // ------------------------------------------------------------------ API
    async function readState() {
      const response = await fetch(API_STATE, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    async function writeMemory(key, content) {
      const response = await fetch(API_WRITE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ key, content })
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    // ------------------------------------------------------------------ 图标
    function MemoryIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true'
        },
        h('path', { key: 'outline', d: 'M3 3.2c1.7 0 3.3.5 5 1.6 1.7-1.1 3.3-1.6 5-1.6v9.2c-1.7 0-3.3.5-5 1.6-1.7-1.1-3.3-1.6-5-1.6z' }),
        h('path', { key: 'spine', d: 'M8 4.8v9.2' }),
        h('path', { key: 'ticks', d: 'M5.2 6.6h1.4M9.4 6.6h1.4M5.2 9h1.4M9.4 9h1.4' })
      )
    }

    // ------------------------------------------------------------------ 面板
    function MemoryPage() {
      const [payload, setPayload] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [selectedKey, setSelectedKey] = useState('global')
      const [draft, setDraft] = useState('')
      const [dirty, setDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(null)
      const [reloadToken, setReloadToken] = useState(0)
      const dirtyRef = useRef(false)

      useEffect(() => {
        let alive = true
        setLoading(true)
        readState()
          .then((next) => {
            if (!alive) return
            setPayload(next)
            setLoadError(null)
          })
          .catch((error) => {
            if (alive) setLoadError(String(error?.message ?? error))
          })
          .finally(() => {
            if (alive) setLoading(false)
          })
        return () => {
          alive = false
        }
      }, [reloadToken])

      const entries = useMemo(() => {
        if (!payload) return []
        return [payload.global, ...(Array.isArray(payload.workspaces) ? payload.workspaces : [])].filter(Boolean)
      }, [payload])

      const projects = useMemo(() => entries.filter((entry) => entry.key !== 'global'), [entries])
      const entry = entries.find((item) => item.key === selectedKey) ?? entries[0]

      useEffect(() => {
        if (!entry || dirtyRef.current) return
        setDraft(typeof entry.content === 'string' ? entry.content : '')
      }, [entry])

      const select = useCallback((key) => {
        dirtyRef.current = false
        setDirty(false)
        setNotice(null)
        setSelectedKey(key)
      }, [])

      const change = useCallback((value) => {
        dirtyRef.current = true
        setDirty(true)
        setNotice(null)
        setDraft(value)
      }, [])

      const limit = entry?.limit ?? 0
      const overLimit = draft.length > limit
      const readOnly = entry ? !entry.writable : true

      const save = useCallback(async () => {
        if (!entry || readOnly || saving || overLimit) return
        setSaving(true)
        setNotice(null)
        try {
          const result = await writeMemory(entry.key, draft)
          dirtyRef.current = false
          setDirty(false)
          setNotice(`${tt('page.saved')} · ${result.chars}/${result.limit} ${tt('page.characters')}`)
          setReloadToken((token) => token + 1)
        } catch (error) {
          setNotice(String(error?.message ?? error))
        } finally {
          setSaving(false)
        }
      }, [draft, entry, overLimit, readOnly, saving])

      const onKeyDown = useCallback(
        (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            void save()
          }
        },
        [save]
      )

      const refresh = useCallback(() => setReloadToken((token) => token + 1), [])

      if (loading && !payload) {
        return h('div', { style: merge(S.root, { alignItems: 'center', justifyContent: 'center' }) }, tt('page.loading'))
      }
      if (loadError && !payload) {
        return h(
          'div',
          { style: merge(S.root, { alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }) },
          h('div', null, `${tt('page.error')}: ${loadError}`),
          h('button', { type: 'button', style: S.button, onClick: refresh }, tt('page.refresh'))
        )
      }

      const itemTitle = (item) => (item.key === 'global' ? tt('page.global') : item.label)
      const itemMeta = (item) => {
        if (item.key !== 'global' && item.default) return tt('page.defaultWorkspace')
        const status = item.exists ? '' : ` · ${tt('page.missing')}`
        return `${item.chars}/${item.limit} ${tt('page.characters')}${status}`
      }

      return h(
        'div',
        { style: S.root },
        h(
          'aside',
          { style: S.aside },
          h(
            'div',
            { style: S.asideHead },
            h('span', null, tt('page.title')),
            h('button', { type: 'button', style: merge(S.button, { padding: '2px 8px' }), onClick: refresh, title: tt('page.refresh') }, tt('page.refresh'))
          ),
          entry
            ? h(
                'button',
                { type: 'button', style: merge(S.item, entry.key === 'global' && S.itemActive), onClick: () => select('global') },
                h('span', { style: S.itemTitle }, itemTitle(payload.global)),
                h('span', { style: S.itemMeta }, itemMeta(payload.global))
              )
            : null,
          h('div', { style: S.sectionLabel }, tt('page.projects')),
          projects.length === 0
            ? h('div', { style: merge(S.itemMeta, { padding: '0 6px' }) }, tt('page.noWorkspace'))
            : projects.map((item) =>
                h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    style: merge(S.item, item.key === entry?.key && S.itemActive),
                    onClick: () => select(item.key),
                    title: item.path
                  },
                  h('span', { style: S.itemTitle }, itemTitle(item)),
                  h('span', { style: S.itemMeta }, itemMeta(item))
                )
              )
        ),
        h(
          'main',
          { style: S.main },
          h(
            'div',
            { style: S.headRow },
            h('h2', { style: S.title }, entry ? itemTitle(entry) : tt('page.title')),
            dirty ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' } }, tt('page.dirty')) : null
          ),
          h('div', { style: { display: 'flex', gap: 10, minWidth: 0, alignItems: 'baseline' } }, h('span', { style: S.path, title: entry?.path }, entry?.path ?? '')),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end' } },
            h(
              'span',
              { style: merge(S.counter, overLimit && S.counterOver) },
              `${draft.length}/${limit} ${tt('page.characters')}`
            )
          ),
          readOnly
            ? h('div', { style: S.banner }, tt('page.defaultWorkspace'))
            : null,
          h('textarea', {
            style: merge(S.textarea, readOnly && { opacity: 0.75 }),
            value: draft,
            readOnly,
            spellCheck: false,
            placeholder: tt('page.empty'),
            onChange: (event) => change(event.target.value),
            onKeyDown
          }),
          h(
            'div',
            { style: S.footer },
            h(
              'span',
              { style: merge(S.hint, notice && { color: overLimit ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)' }) },
              notice ?? (overLimit ? tt('page.over') : tt('page.hint'))
            ),
            h(
              'button',
              {
                type: 'button',
                style: merge(S.buttonPrimary, (saving || readOnly || overLimit || !dirty) && S.disabled),
                disabled: saving || readOnly || overLimit || !dirty,
                onClick: save
              },
              saving ? tt('page.saving') : tt('page.save')
            )
          )
        )
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-memory.locale')
        } catch (error) {
          console.warn('[dsh-memory] locale.register failed', error)
        }
        try {
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') tt = bound
        } catch (error) {
          console.warn('[dsh-memory] locale.bind failed', error)
        }

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => tt('entry.label') }, MemoryIcon)
            ),
          'dsh-memory.panel-icon'
        )
        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MemoryPage)),
          'dsh-memory.panel-page'
        )
      }
    }
  }
})
