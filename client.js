// Browser half: the plugin's configuration page on the Plugins page, where the
// extraction and consolidation models are chosen from DSH's live model catalog.
// Writes go through configForms to the row's volatile fields, so they apply
// without restarting the plugin.
window.__ModuleLoader__.load({
  id: '@libraqg/dsh-memories',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'libraqgMemories'
    const ENTRY_ID = 'memories'
    const SLOT_KEY = '@libraqg/dsh-memories#memories'
    const STAGES = [
      { field: 'extractModel', label: 'extractLabel', hint: 'extractHint', fallback: 'deepseek-official / deepseek-flash' },
      { field: 'consolidationModel', label: 'consolidationLabel', hint: 'consolidationHint', fallback: 'deepseek-official / deepseek-v4-pro' },
    ]

    const zh = {
      summary: '抽取：{extract} · 整理：{consolidation}',
      defaultModel: '默认',
      useDefault: '默认（{model}）',
      extractLabel: '抽取模型',
      extractHint: '从每个会话中提取候选记忆，调用次数多，适合快而便宜的模型。',
      consolidationLabel: '整理模型',
      consolidationHint: '在后台去重、合并和更新记忆，调用次数少，适合更强的模型。',
      unavailable: '{model}（当前不可用）',
      catalogLoading: '正在读取模型列表…',
      catalogError: '模型列表读取失败，可稍后重试。',
      catalogPartial: '部分模型来源读取失败，列表可能不完整。',
      retry: '重试',
      save: '保存',
      discard: '放弃修改',
      saving: '正在保存…',
      saved: '已保存，下次后台运行时生效。',
      failed: '保存失败，请重试。',
      conflict: '配置已在别处被修改，请放弃修改后重新选择。',
      readOnly: '当前配置不可写（可能被更高优先级的配置覆盖）。',
      loading: '正在读取配置…',
      note: '修改只影响之后的后台运行；正在进行的整理不受影响。',
    }
    const en = {
      summary: 'Extraction: {extract} · Consolidation: {consolidation}',
      defaultModel: 'default',
      useDefault: 'Default ({model})',
      extractLabel: 'Extraction model',
      extractHint: 'Pulls candidate memories out of each conversation. Called often; a fast, inexpensive model fits.',
      consolidationLabel: 'Consolidation model',
      consolidationHint: 'Deduplicates, merges and updates memories in the background. Called rarely; a stronger model fits.',
      unavailable: '{model} (currently unavailable)',
      catalogLoading: 'Loading models…',
      catalogError: 'Could not load the model list. Try again later.',
      catalogPartial: 'Some model sources failed to load; the list may be incomplete.',
      retry: 'Retry',
      save: 'Save',
      discard: 'Discard changes',
      saving: 'Saving…',
      saved: 'Saved. Applies from the next background run.',
      failed: 'Could not save. Try again.',
      conflict: 'The configuration changed elsewhere. Discard and choose again.',
      readOnly: 'This configuration is read-only here (a higher-priority layer may override it).',
      loading: 'Loading configuration…',
      note: 'Changes apply to later background runs; a consolidation already running is not affected.',
    }

    /** Option value for a route; JSON keeps any character a provider or model id may contain. */
    function routeKey(route) {
      return route && route.provider && route.model ? JSON.stringify([route.provider, route.model]) : ''
    }

    function routeLabel(route, t) {
      return route && route.provider && route.model ? `${route.provider} / ${route.model}` : t('defaultModel')
    }

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_, name) => (values[name] === undefined ? '' : values[name]))
    }

    function useFormSnapshot(scope) {
      return React.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
      )
    }

    function useCatalog(remote) {
      const [state, setState] = React.useState({ status: 'loading', groups: [], partial: false })
      const [attempt, setAttempt] = React.useState(0)
      React.useEffect(() => {
        let live = true
        setState({ status: 'loading', groups: [], partial: false })
        Promise.resolve(remote.session.modelCatalog()).then(
          (response) => {
            if (!live) return
            if (response && response.ok) {
              setState({ status: 'ready', groups: response.value.groups, partial: response.value.failures.length > 0 })
            } else setState({ status: 'error', groups: [], partial: false })
          },
          () => live && setState({ status: 'error', groups: [], partial: false }),
        )
        return () => {
          live = false
        }
      }, [remote, attempt])
      return [state, () => setAttempt((value) => value + 1)]
    }

    const styles = {
      page: { display: 'grid', gap: 20, maxWidth: 640, color: 'var(--dsw-alias-label-primary)', fontSize: 14 },
      field: { display: 'grid', gap: 6 },
      label: { fontWeight: 600 },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' },
      select: {
        height: 34, padding: '0 10px', borderRadius: 8, fontSize: 14,
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      notice: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      button: (primary) => ({
        height: 32, padding: '0 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
        border: primary ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l2)',
        background: primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
        color: primary ? 'var(--dsw-alias-label-primary-inverted)' : 'var(--dsw-alias-label-primary)',
      }),
    }

    function ModelSelect({ t, stage, value, current, groups, disabled, onChange }) {
      const known = new Set()
      const optionGroups = groups.map((group) =>
        h('optgroup', { key: group.id, label: group.name || group.id },
          group.models.map((model) => {
            const key = routeKey({ provider: group.id, model: model.id })
            known.add(key)
            return h('option', { key, value: key }, model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id)
          })),
      )
      const options = [h('option', { key: 'default', value: '' }, format(t('useDefault'), { model: stage.fallback }))]
      if (value !== '' && !known.has(value) && current && routeKey(current) === value) {
        options.push(h('option', { key: 'unavailable', value }, format(t('unavailable'), { model: routeLabel(current, t) })))
      }
      return h('select', {
        style: styles.select,
        value,
        disabled,
        'aria-label': t(stage.label),
        onChange: (event) => onChange(event.target.value),
      }, options, optionGroups)
    }

    function ConfigPage({ t, scope, remote }) {
      const snapshot = useFormSnapshot(scope)
      const [catalog, retryCatalog] = useCatalog(remote)
      const [draft, setDraft] = React.useState(undefined)
      const [status, setStatus] = React.useState({ kind: 'idle' })

      if (!snapshot || snapshot.status !== 'ready') return h('div', { style: styles.notice }, t('loading'))
      const stored = snapshot.value || {}
      const current = Object.fromEntries(STAGES.map((stage) => [stage.field, routeKey(stored[stage.field])]))
      const values = draft ? draft.values : current
      const dirty = STAGES.some((stage) => values[stage.field] !== current[stage.field])
      const busy = status.kind === 'saving'
      const conflict = draft !== undefined && draft.revision !== snapshot.revision

      function select(field, key) {
        setStatus({ kind: 'idle' })
        setDraft((previous) => ({
          revision: previous ? previous.revision : snapshot.revision,
          values: { ...(previous ? previous.values : current), [field]: key },
        }))
      }

      async function save() {
        const operations = STAGES.filter((stage) => values[stage.field] !== current[stage.field]).map((stage) => {
          const key = values[stage.field]
          if (key === '') return { op: 'unset', path: [stage.field] }
          const [provider, model] = JSON.parse(key)
          return { op: 'set', path: [stage.field], value: { provider, model } }
        })
        setStatus({ kind: 'saving' })
        try {
          await scope.mutate(operations, draft.revision)
          const landed = STAGES.every((stage) => routeKey((scope.getSnapshot().value || {})[stage.field]) === values[stage.field])
          if (landed) {
            setDraft(undefined)
            setStatus({ kind: 'saved' })
          } else setStatus({ kind: 'failed' })
        } catch {
          setStatus({ kind: 'failed' })
        }
      }

      const catalogNotice =
        catalog.status === 'loading' ? t('catalogLoading')
          : catalog.status === 'error' ? t('catalogError')
            : catalog.partial ? t('catalogPartial') : undefined
      const message =
        !snapshot.writable ? t('readOnly')
          : conflict ? t('conflict')
            : status.kind === 'saving' ? t('saving')
              : status.kind === 'saved' ? t('saved')
                : status.kind === 'failed' ? t('failed') : t('note')

      return h('div', { style: styles.page },
        STAGES.map((stage) =>
          h('label', { key: stage.field, style: styles.field },
            h('span', { style: styles.label }, t(stage.label)),
            h(ModelSelect, {
              t, stage, groups: catalog.groups, value: values[stage.field], current: stored[stage.field],
              disabled: !snapshot.writable || busy,
              onChange: (key) => select(stage.field, key),
            }),
            h('span', { style: styles.hint }, t(stage.hint)))),
        catalogNotice === undefined ? null : h('div', { style: styles.actions },
          h('span', { style: styles.notice }, catalogNotice),
          catalog.status === 'error' ? h('button', { type: 'button', style: styles.button(false), onClick: retryCatalog }, t('retry')) : null),
        h('div', { style: styles.actions },
          h('button', {
            type: 'button', style: styles.button(true),
            disabled: !dirty || busy || conflict || !snapshot.writable, onClick: save,
          }, t('save')),
          dirty || conflict ? h('button', {
            type: 'button', style: styles.button(false), disabled: busy,
            onClick: () => { setDraft(undefined); setStatus({ kind: 'idle' }) },
          }, t('discard')) : null),
        h('div', { style: styles.notice, role: 'status' }, message))
    }

    function Summary({ t, scope }) {
      const snapshot = useFormSnapshot(scope)
      const stored = (snapshot && snapshot.value) || {}
      return format(t('summary'), { extract: routeLabel(stored.extractModel, t), consolidation: routeLabel(stored.consolidationModel, t) })
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memories: dictionaries')
        const scope = ctx.configForms.get(ENTRY_ID)
        const Entry = ({ t, view }) => (view === 'summary' ? h(Summary, { t, scope }) : h(ConfigPage, { t, scope, remote: ctx.remote }))
        ctx.effect(
          () => ctx.configForms.whileServed([ENTRY_ID], () =>
            ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register({ name: 'plugins.row.config', key: SLOT_KEY, locale: NS }, Entry))),
          'memories: configuration page',
        )
      },
    }
  },
})
