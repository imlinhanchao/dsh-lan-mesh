/**
 * Browser half: the row settings page for dsh-lan-mesh.
 *
 * Registers into the Plugins page's `plugins.row.config` slot for
 * `dsh-lan-mesh#lan-mesh`, so the installed bundle's row gets a Configure
 * control whose page edits the shared token, the peer name and the remote
 * command switch. The page reads and writes the row's validated Host Config
 * through the `form` the Plugins page supplies, so a save goes through the
 * same config editor every official settings page uses.
 */
window.__ModuleLoader__.load({
  id: 'dsh-lan-mesh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const NS = 'lanMesh'

    const DICT = {
      zh: {
        summary: '共享 token、节点名与远程命令开关',
        heading: '内网 DSH 互联',
        intro: '这些设置写入本机 profile 的 cordis.patch.yml。保存后立即生效，不需要重启 DSH。',
        name: '节点名称',
        nameHint: '显示在其它机器的 lan_peers 里。留空则使用 DSH_LAN_NAME 或主机名。',
        token: '共享 token',
        tokenHint: '每台机器必须一致。留空则回退到 DSH_LAN_TOKEN 或 <DSH_HOME>/lan-mesh/token。',
        tokenPlaceholder: '留空表示使用环境变量或 token 文件',
        fingerprint: '指纹',
        allowExec: '允许远端执行 shell 命令（lan_exec）',
        allowExecHint: '关闭后其它机器只能委派任务（lan_delegate），不能直接运行命令。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存，已立即生效。',
        rejected: '保存被拒绝：这一行配置可能被更高层的 patch 覆盖。',
        unchanged: '没有改动。',
        noForm: '当前部署没有暴露可编辑配置（@deepseek-ai/schemastery 不可用）。请直接在 profile 的 cordis.patch.yml 中配置。',
        readonly: '这一行配置由 profile 上层 patch 固定，无法在这里修改。',
        show: '显示',
        hide: '隐藏',
      },
      en: {
        summary: 'Shared token, peer name, and the remote command switch',
        heading: 'LAN mesh peers',
        intro: 'These settings are written to this machine\'s profile cordis.patch.yml. A save applies immediately; DSH does not need a restart.',
        name: 'Peer name',
        nameHint: 'Shown as this machine in other peers\' lan_peers. Empty uses DSH_LAN_NAME or the host name.',
        token: 'Shared token',
        tokenHint: 'Every machine must use the same value. Empty falls back to DSH_LAN_TOKEN, then <DSH_HOME>/lan-mesh/token.',
        tokenPlaceholder: 'Empty means the environment variable or token file',
        fingerprint: 'Fingerprint',
        allowExec: 'Allow peers to run shell commands (lan_exec)',
        allowExecHint: 'When off, peers can still delegate tasks with lan_delegate but cannot run commands directly.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved and applied immediately.',
        rejected: 'Save rejected: a higher profile patch may override this row.',
        unchanged: 'Nothing to save.',
        noForm: 'This deployment exposes no editable config (@deepseek-ai/schemastery is unavailable). Configure the profile cordis.patch.yml instead.',
        readonly: 'A higher profile patch pins this row, so it cannot be changed here.',
        show: 'Show',
        hide: 'Hide',
      },
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '560px' },
      heading: { margin: 0, fontSize: '15px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      hint: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      input: {
        boxSizing: 'border-box',
        height: '36px',
        padding: '0 12px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '8px',
        outline: 'none',
      },
      tokenRow: { display: 'flex', gap: '8px', alignItems: 'center' },
      tokenInput: { flex: '1 1 auto' },
      ghostButton: {
        flex: 'none',
        height: '36px',
        padding: '0 12px',
        fontSize: '12.5px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        border: '.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '8px',
        cursor: 'pointer',
      },
      checkRow: { display: 'flex', gap: '8px', alignItems: 'flex-start' },
      checkbox: { marginTop: '3px', width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)', flex: 'none' },
      fingerprint: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' },
      actions: { display: 'flex', alignItems: 'center', gap: '12px' },
      save: {
        height: '32px',
        padding: '0 16px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary-foreground)',
        background: 'var(--dsw-alias-state-business-primary)',
        border: 0,
        borderRadius: '8px',
        cursor: 'pointer',
      },
      ok: { margin: 0, fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary)' },
      error: { margin: 0, fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
    }

    /** SHA-256 prefix of a token, so two machines can be compared without revealing it. */
    async function tokenFingerprint(token) {
      if (token === '') return ''
      const subtle = globalThis.crypto?.subtle
      if (subtle === undefined) return ''
      const bytes = new TextEncoder().encode(token)
      const digest = await subtle.digest('SHA-256', bytes)
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
    }

    function ConfigForm({ t, form }) {
      const state = form.state ?? {}
      const value = state.value ?? {}
      const revision = state.revision
      const writable = state.writable !== false
      const [name, setName] = useState(String(value.name ?? ''))
      const [token, setToken] = useState(String(value.token ?? ''))
      const [allowExec, setAllowExec] = useState(value.allowExec !== false)
      const [showToken, setShowToken] = useState(false)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [fingerprint, setFingerprint] = useState('')

      // Follow the Host document: a save (or an outside edit) moves the revision.
      useEffect(() => {
        const next = form.state?.value ?? {}
        setName(String(next.name ?? ''))
        setToken(String(next.token ?? ''))
        setAllowExec(next.allowExec !== false)
      }, [revision])

      useEffect(() => {
        let live = true
        tokenFingerprint(token.trim()).then((hex) => {
          if (live) setFingerprint(hex)
        }).catch(() => {})
        return () => {
          live = false
        }
      }, [token])

      const stored = {
        name: String(value.name ?? ''),
        token: String(value.token ?? ''),
        allowExec: value.allowExec !== false,
      }
      const dirty = name !== stored.name || token !== stored.token || allowExec !== stored.allowExec

      async function save() {
        if (!writable) return
        const ops = []
        if (name !== stored.name) ops.push({ op: 'set', path: ['name'], value: name.trim() })
        if (token !== stored.token) ops.push({ op: 'set', path: ['token'], value: token.trim() })
        if (allowExec !== stored.allowExec) ops.push({ op: 'set', path: ['allowExec'], value: allowExec })
        if (ops.length === 0) {
          setNotice({ kind: 'ok', text: t('unchanged') })
          return
        }
        setBusy(true)
        setNotice(null)
        try {
          const accepted = await form.mutate(ops, revision)
          setNotice(accepted ? { kind: 'ok', text: t('saved') } : { kind: 'error', text: t('rejected') })
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: styles.root },
        h('p', { style: styles.heading }, t('heading')),
        h('p', { style: styles.intro }, t('intro')),
        h('div', { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'lan-mesh-name' }, t('name')),
          h('input', {
            id: 'lan-mesh-name',
            type: 'text',
            style: styles.input,
            value: name,
            disabled: !writable || busy,
            placeholder: 'hancel-service',
            onChange: (event) => setName(event.target.value),
          }),
          h('p', { style: styles.hint }, t('nameHint')),
        ),
        h('div', { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'lan-mesh-token' }, t('token')),
          h('div', { style: styles.tokenRow },
            h('input', {
              id: 'lan-mesh-token',
              type: showToken ? 'text' : 'password',
              autoComplete: 'off',
              spellCheck: false,
              style: { ...styles.input, ...styles.tokenInput },
              value: token,
              disabled: !writable || busy,
              placeholder: t('tokenPlaceholder'),
              onChange: (event) => setToken(event.target.value),
            }),
            h('button', {
              type: 'button',
              style: styles.ghostButton,
              disabled: busy,
              onClick: () => setShowToken((shown) => !shown),
            }, showToken ? t('hide') : t('show')),
          ),
          h('p', { style: styles.hint }, t('tokenHint')),
          fingerprint === ''
            ? null
            : h('p', { style: styles.fingerprint }, `${t('fingerprint')}: ${fingerprint}`),
        ),
        h('div', { style: styles.field },
          h('label', { style: styles.checkRow },
            h('input', {
              type: 'checkbox',
              style: styles.checkbox,
              checked: allowExec,
              disabled: !writable || busy,
              onChange: (event) => setAllowExec(event.target.checked),
            }),
            h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
              h('span', { style: styles.label }, t('allowExec')),
              h('span', { style: styles.hint }, t('allowExecHint')),
            ),
          ),
        ),
        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            style: { ...styles.save, opacity: !writable || busy || !dirty ? 0.55 : 1, cursor: !writable || busy ? 'default' : 'pointer' },
            disabled: !writable || busy || !dirty,
            onClick: save,
          }, busy ? t('saving') : t('save')),
          notice === null ? null : h('p', { style: notice.kind === 'ok' ? styles.ok : styles.error }, notice.text),
        ),
        writable ? null : h('p', { style: styles.error }, t('readonly')),
      )
    }

    function RowConfigPage({ t, view, form }) {
      if (view === 'summary') {
        return h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12.5px' } }, t('summary'))
      }
      if (form === undefined) {
        return h('p', { style: styles.hint }, t('noForm'))
      }
      return h(ConfigForm, { t, form })
    }

    var name = 'lan-mesh'
    var inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'lan-mesh: client dictionaries')
      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-lan-mesh#lan-mesh',
        locale: NS,
      }, RowConfigPage)), 'lan-mesh: plugin row settings page')
    }

    module.exports = { name, inject, apply }
    return module.exports
  },
})
