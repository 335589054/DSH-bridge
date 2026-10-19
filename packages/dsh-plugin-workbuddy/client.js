window.__ModuleLoader__.load({
  id: 'dsh-plugin-workbuddy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, Component } = React

    const BRIDGE = 'http://127.0.0.1:8790'
    const ADMIN = { 'x-bridge-admin': '1' }

    // 主题令牌：跟随 DSH 的明暗主题，不写死颜色（令牌改名只会掉色，不会崩）
    const C = {
      label: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, rgba(128,128,128,.9))',
      muted: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))',
      border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
      cardFill: 'var(--dsw-alias-settings-card-fill, rgba(128,128,128,.04))',
      primary: 'var(--dsw-alias-button-primary-fill, #3d6bf5)',
      primaryText: 'var(--dsw-alias-label-primary-foreground, #fff)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))',
      ok: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      warn: 'var(--dsw-alias-state-warn-label, #e8590c)',
      bad: 'var(--dsw-alias-state-error-primary, #e03131)',
    }
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    const PHASE = {
      venv: '建虚拟环境',
      'venv-reset': '重建虚拟环境',
      install: '装依赖',
      done: '完成',
      error: '失败',
    }

    async function api(path, method = 'GET', body) {
      let res
      try {
        res = await fetch(BRIDGE + path, {
          method,
          headers: method === 'POST' ? { ...ADMIN, 'content-type': 'application/json' } : ADMIN,
          body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
        })
      } catch (e) {
        throw new Error(`连不上 ${BRIDGE}（${(e && e.message) || e}）`)
      }
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = { error: { message: text } }
      }
      if (!res.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`)
      return data
    }

    /** 剪贴板：桌面端安全上下文里优先用 Clipboard API，老环境回落到 execCommand */
    async function copyToClipboard(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* 继续走回落 */
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const done = document.execCommand('copy')
        document.body.removeChild(ta)
        return done
      } catch {
        return false
      }
    }

    function Dot({ ok, warn }) {
      const color = ok ? C.ok : warn ? C.warn : C.bad
      return h('span', {
        style: {
          display: 'inline-block', width: 8, height: 8, borderRadius: 4,
          background: color, marginRight: 6, flex: '0 0 auto',
        },
      })
    }

    function Row({ label, children, copy }) {
      return h('div', { style: { display: 'flex', gap: 10, padding: '4px 0', alignItems: 'center', minWidth: 0 } },
        h('span', { style: { color: C.muted, minWidth: 64, flex: '0 0 auto', fontSize: 12 } }, label),
        h('span', {
          style: { fontSize: 13, color: C.label, wordBreak: 'break-all', minWidth: 0, flex: '1 1 auto' },
        }, children),
        copy
          ? h('span', { style: { display: 'flex', gap: 6, flex: '0 0 auto', alignItems: 'center' } }, copy)
          : null)
    }

    function Btn({ children, onClick, busy, disabled, kind, title }) {
      const primary = kind === 'primary'
      return h('button', {
        type: 'button',
        onClick,
        disabled: busy || disabled,
        title,
        style: {
          fontSize: 12, lineHeight: '18px', padding: '4px 10px', borderRadius: 6,
          cursor: busy || disabled ? 'default' : 'pointer',
          border: primary ? '1px solid transparent' : C.border,
          background: primary ? C.primary : 'transparent',
          color: primary ? C.primaryText : C.label,
          opacity: busy || disabled ? 0.45 : 1,
          fontFamily: 'inherit', whiteSpace: 'nowrap',
        },
      }, children)
    }

    /** 开关：主题色取成功色，关时用中性灰，不写死具体色值 */
    function Toggle({ on, onClick, busy, disabled, title }) {
      return h('button', {
        type: 'button',
        onClick,
        disabled: busy || disabled,
        title,
        'aria-pressed': on ? 'true' : 'false',
        style: {
          width: 34, height: 18, borderRadius: 9, border: 'none', padding: 0,
          position: 'relative', flex: '0 0 auto',
          cursor: busy || disabled ? 'default' : 'pointer',
          background: on ? C.ok : 'rgba(128,128,128,.35)',
          opacity: busy || disabled ? 0.45 : 1,
          transition: 'background .15s',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14,
          borderRadius: 7, background: '#fff', transition: 'left .15s',
          boxShadow: '0 1px 2px rgba(0,0,0,.25)',
        },
      }))
    }

    /** 文本输入框：样式贴着 Btn 来，保持面板观感一致 */
    function Input({ value, onChange, placeholder, mono, width }) {
      return h('input', {
        value,
        onChange: (e) => onChange(e.target.value),
        placeholder,
        style: {
          fontSize: 12, lineHeight: '18px', padding: '4px 8px', borderRadius: 6,
          border: C.border, background: 'transparent', color: C.label,
          fontFamily: mono ? MONO : 'inherit',
          flex: `1 1 ${width || 200}px`, minWidth: 0,
        },
      })
    }

    function Card({ title, hint, children }) {
      return h('section', {
        style: {
          border: C.border, background: C.cardFill, borderRadius: 10,
          padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 2,
        },
      },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 4 } }, title),
        hint ? h('div', { style: { fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 4 } }, hint) : null,
        children)
    }

    /** 一个槽位崩掉会让整块面板空白，所以自己兜一层 */
    class Boundary extends Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          const msg = String((this.state.error && this.state.error.message) || this.state.error)
          return h('div', { style: { fontSize: 13, color: C.bad, lineHeight: 1.7 } },
            'WorkBuddy 面板渲染出错：', msg)
        }
        return this.props.children
      }
    }

    function LinkCard({ link, busy, onRefetch, onCopy, lan }) {
      const [reveal, setReveal] = useState(false)
      if (!link) {
        return h(Card, { title: '桥接链接' },
          h('div', { style: { fontSize: 12, color: C.muted, lineHeight: 1.7 } },
            '网关没起来，暂时取不到链接。先在本机跑一次 install.mjs 拉起 bridge，或手动 node packages/bridge/server.mjs。'))
      }
      const token = reveal ? link.apiKey : link.apiKeyMasked
      return h(Card, {
        title: '桥接链接',
        hint: '任何 OpenAI 兼容客户端（脚本、Cline、Cherry Studio…）填这三样就能用，不必经过 DSH。',
      },
        h(Row, { label: '地址', copy: h(Btn, { onClick: () => onCopy(link.baseUrl, '地址已复制') }, '复制') },
          h('span', { style: { fontFamily: MONO } }, link.baseUrl)),
        h(Row, {
          label: '令牌',
          copy: h('span', { style: { display: 'flex', gap: 6 } },
            h(Btn, { onClick: () => setReveal(!reveal), title: '令牌只在本机内存里' }, reveal ? '隐藏' : '显示'),
            h(Btn, { onClick: () => onCopy(link.apiKey, '令牌已复制') }, '复制')),
        }, h('span', { style: { fontFamily: MONO } }, token)),
        h(Row, { label: '模型', copy: h(Btn, { onClick: () => onCopy(link.snippets.curl, 'curl 已复制') }, '复制 curl') },
          `${link.defaultModel} · 共 ${link.models.length} 个`),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h(Btn, { kind: 'primary', onClick: () => onCopy(link.copyText, '地址+令牌已复制') }, '复制地址+令牌'),
          h(Btn, { onClick: () => onCopy(link.snippets.json, 'JSON 已复制') }, '复制 JSON'),
          h(Btn, { onClick: () => onCopy(link.snippets.env, '.env 已复制') }, '复制 .env'),
          h(Btn, { onClick: onRefetch, busy: busy === 'link' }, '重新抓取')),
        h('div', { style: { fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.6 } },
          `${link.mode === 'mock' ? 'mock 模式（不会打到上游）' : `转发到 ${link.upstream}`} · `,
          link.captured ? '会话已捕获' : '会话未捕获，请求会因缺凭证失败'),
        link.lan && link.lan.enabled
          ? h('div', { style: { fontSize: 11, color: C.warn, marginTop: 2, lineHeight: 1.6 } },
              '上面的令牌仅限本机使用；局域网客户端请用「API 密钥」卡片里生成的 wbk_ 密钥。')
          : null)
    }

    // 与 bridge/lan.mjs 的 API_DEFS 对应（UI 自己一份展示名，避免多一次往返）
    const API_META = {
      chat: { label: '对话', route: 'POST /v1/chat/completions' },
      models: { label: '模型列表', route: 'GET /v1/models' },
    }

    function LanCard({ lan, busy, act, copy }) {
      if (!lan) return null
      const on = lan.enabled
      return h(Card, {
        title: '局域网访问',
        hint: '开启后同网段的设备就能调用 bridge。只接受内网来源（10.x / 172.16-31.x / 192.168.x / 169.254.x），公网来源一律 403；管理接口无论开关都只接受本机。',
      },
        h(Row, {
          label: '监听',
          copy: h(Btn, {
            onClick: act('lan', async () => api('/setup/lan', 'POST', { enabled: !on })),
            busy: busy === 'lan',
            kind: on ? undefined : 'primary',
          }, on ? '关闭局域网' : '开启局域网'),
        }, h(Dot, { ok: on }), on ? '0.0.0.0（仅内网来源）' : '127.0.0.1（仅本机）'),
        on && lan.urls && lan.urls.length
          ? h(Row, { label: '内网地址', copy: h(Btn, { onClick: () => copy(lan.urls[0], '内网地址已复制') }, '复制') },
              h('span', { style: { fontFamily: MONO } }, lan.urls.join('   ')))
          : null,
        on && lan.urls && lan.urls.length
          ? h('div', { style: { fontSize: 11, color: C.muted, marginTop: 4, lineHeight: 1.7 } },
              '客户端按 DeepSeek 的格式填：地址填上面的内网地址，模型选 ',
              h('span', { style: { fontFamily: MONO } }, 'deepseek-chat'),
              ' / ',
              h('span', { style: { fontFamily: MONO } }, 'deepseek-reasoner'),
              '，密钥用下面「API 密钥」里生成的 wbk_ 开头密钥。首次被访问时 Windows 可能弹防火墙，选「允许」。')
          : null,
        on && !lan.lanReady
          ? h('div', { style: { fontSize: 12, color: C.warn, marginTop: 8, lineHeight: 1.6 } },
              '局域网已开启，但还没有可用的 API 密钥 —— 在下面「API 密钥」里生成一把，否则局域网客户端会全部返回 401。')
          : null)
    }

    function KeysCard({ lan, busy, act, actRaw, copy, newKey, setNewKey, keyName, setKeyName, verifyInput, setVerifyInput, verifyResult }) {
      const keys = (lan && lan.keys) || []
      return h(Card, {
        title: 'API 密钥',
        hint: '局域网客户端持密钥调用（Authorization: Bearer wbk_…）。只存 SHA-256 哈希，明文仅在生成时显示一次；校验在本机完成，不请求上游。本机令牌（wb_…）仅限本机使用。',
      },
        h('div', { style: { display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' } },
          h(Input, { value: keyName, onChange: setKeyName, placeholder: '备注，如：手机 / 客厅电脑', width: 200 }),
          h(Btn, {
            kind: 'primary',
            busy: busy === 'keynew',
            onClick: actRaw('keynew', async () => {
              const r = await api('/setup/keys', 'POST', { name: keyName.trim() || '未命名密钥' })
              if (r && r.ok) {
                setNewKey(r.key)
                setKeyName('')
              }
              return r
            }),
          }, '生成密钥')),
        newKey
          ? h('div', {
              style: {
                marginTop: 8, padding: '8px 10px', borderRadius: 6, border: C.border,
                background: C.cardFill,
              },
            },
              h('div', { style: { fontSize: 11, color: C.warn, marginBottom: 4 } }, '密钥只显示这一次，现在复制走：'),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: { fontFamily: MONO, fontSize: 12, wordBreak: 'break-all', flex: '1 1 auto', color: C.label } }, newKey),
                h(Btn, { onClick: () => copy(newKey, '密钥已复制') }, '复制'),
                h(Btn, { onClick: () => setNewKey(null) }, '知道了')))
          : null,
        keys.length
          ? h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
              keys.map((k) =>
                h('div', {
                  key: k.id,
                  style: {
                    display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px',
                    borderRadius: 6, border: C.border, fontSize: 12,
                  },
                },
                  h('span', {
                    style: { fontWeight: 600, color: C.label, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  }, k.name),
                  h('span', { style: { fontFamily: MONO, color: C.muted, flex: '0 0 auto' } }, k.prefix),
                  h('span', { style: { color: C.muted, flex: '1 1 auto', fontSize: 11 } },
                    k.lastUsedAt ? `最近使用 ${k.lastUsedAt.replace('T', ' ').slice(0, 19)}` : '未使用'),
                  h(Toggle, {
                    on: k.enabled,
                    busy: busy === 'k-' + k.id,
                    title: k.enabled ? '停用这把密钥' : '重新启用这把密钥',
                    onClick: act('k-' + k.id, async () => api('/setup/keys/enable', 'POST', { id: k.id, enabled: !k.enabled })),
                  }),
                  h(Btn, {
                    busy: busy === 'del-' + k.id,
                    onClick: act('del-' + k.id, async () => api('/setup/keys/delete', 'POST', { id: k.id })),
                  }, '删除'))))
          : h('div', { style: { fontSize: 12, color: C.muted, marginTop: 8 } }, '还没有密钥。'),        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' } },
          h(Input, { value: verifyInput, onChange: setVerifyInput, placeholder: '粘贴一把密钥做本地校验', mono: true, width: 240 }),
          h(Btn, {
            busy: busy === 'verify',
            disabled: !verifyInput.trim(),
            onClick: actRaw('verify', async () => {
              const r = await api('/setup/keys/verify', 'POST', { key: verifyInput.trim() })
              setVerifyResult(r)
              return r
            }),
          }, '验证')),
        verifyResult
          ? h('div', {
              style: {
                fontSize: 12, marginTop: 6, lineHeight: 1.6,
                color: verifyResult.ok ? C.ok : C.bad,
              },
            },
              verifyResult.ok
                ? `✓ ${verifyResult.message}${verifyResult.lan && !verifyResult.lan.enabled ? '（局域网未开启，目前仅本机可用）' : ''}`
                : `✗ ${verifyResult.error}`)
          : null)
    }

    function ApisCard({ lan, busy, act }) {
      const apis = (lan && lan.apis) || {}
      return h(Card, {
        title: 'API 开关',
        hint: '关掉后对应接口返回 503。比如只想给局域网开放对话、不想暴露模型清单时，把「模型列表」关掉即可。',
      },
        Object.entries(apis).map(([name, on]) =>
          h(Row, {
            key: name,
            label: (API_META[name] && API_META[name].label) || name,
            copy: h(Toggle, {
              on: on !== false,
              busy: busy === 'api-' + name,
              title: on !== false ? '点击关闭' : '点击开启',
              onClick: act('api-' + name, async () => api('/setup/api', 'POST', { name, enabled: on === false })),
            }),
          }, h(Dot, { ok: on !== false }), h('span', { style: { fontFamily: MONO } }, (API_META[name] && API_META[name].route) || name))))
    }

    function Panel() {
      const [status, setStatus] = useState(null)
      const [link, setLink] = useState(null)
      const [health, setHealth] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState(null)
      // 局域网 / 密钥相关的本地状态（明文密钥只留在内存里，不写任何存储）
      const [newKey, setNewKey] = useState(null)
      const [keyName, setKeyName] = useState('')
      const [verifyInput, setVerifyInput] = useState('')
      const [verifyResult, setVerifyResult] = useState(null)

      const loadLink = useCallback(async () => {
        try {
          setLink(await api('/setup/link'))
        } catch {
          setLink(null)
        }
      }, [])

      const refresh = useCallback(async (fresh = false) => {
        try {
          const [s, hl] = await Promise.all([
            api(`/setup/status${fresh ? '?fresh=1' : ''}`),
            fetch(BRIDGE + '/health').then((r) => (r.ok ? r.json() : null)).catch(() => null),
          ])
          setStatus(s)
          setHealth(hl)
          setError(null)
        } catch (e) {
          setStatus(null)
          setHealth(null)
          setError(String((e && e.message) || e))
        }
      }, [])

      useEffect(() => {
        refresh()
        loadLink()
        let timer = null
        const start = () => {
          if (timer) return
          timer = setInterval(() => {
            if (!document.hidden) refresh()
          }, 3000)
        }
        const stop = () => {
          if (timer) {
            clearInterval(timer)
            timer = null
          }
        }
        const onVisibility = () => {
          if (document.hidden) {
            stop()
          } else {
            refresh()
            start()
          }
        }
        start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [refresh, loadLink])

      const act = (name, fn) => async () => {
        setBusy(name)
        setNote(null)
        try {
          const r = await fn()
          if (r && r.ok === false) setNote({ bad: true, text: r.error || '操作失败' })
          else if (r && r.started) setNote({ text: '已开始，稍等片刻…' })
          else setNote({ text: '' })
          await refresh()
          await loadLink()
        } catch (e) {
          setNote({ bad: true, text: String((e && e.message) || e) })
        } finally {
          setBusy('')
        }
      }

      /** 与 act 相同，但把接口返回值交回去（生成密钥要拿一次性明文） */
      const actRaw = (name, fn) => async () => {
        setBusy(name)
        setNote(null)
        try {
          const r = await fn()
          await refresh()
          await loadLink()
          return r
        } catch (e) {
          setNote({ bad: true, text: String((e && e.message) || e) })
          return null
        } finally {
          setBusy('')
        }
      }

      const copy = async (text, okText) => {
        const done = await copyToClipboard(String(text || ''))
        setNote(done ? { text: okText } : { bad: true, text: '复制失败，请手动选中复制' })
      }

      if (error) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 760 } },
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, color: C.label } }, 'WorkBuddy'),
          h(Card, { title: '网关未连接' },
            h(Row, { label: '地址' }, h(Dot, { ok: false }), `127.0.0.1:8790`),
            h('div', { style: { fontSize: 12, color: C.muted, lineHeight: 1.7, marginTop: 4 } },
              'bridge 没在跑。DSH 启动时会自动拉起它 —— 重启一次 DSH 即可；也可以双击 packages/bridge/start.cmd，或 node packages/bridge/server.mjs。'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
              h(Btn, { kind: 'primary', onClick: act('retry', async () => { await refresh(); await loadLink() }) }, '重试')),
            h('pre', { style: { fontSize: 11, color: C.muted, whiteSpace: 'pre-wrap', marginTop: 8, fontFamily: MONO } }, error)))
      }

      if (!status) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 } },
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, color: C.label } }, 'WorkBuddy'),
          h(Card, { title: '运行状态' },
            h('div', { style: { fontSize: 12, color: C.muted, lineHeight: 1.7 } },
              '读取状态…（首次要探测 Python / mitmproxy / 证书，可能要几秒）')))
      }

      const install = status.install || {}
      const capture = status.capture || {}
      const proxy = status.proxy || {}
      // 老 bridge 没有 client 字段（还是注册表那版），取空对象即可，不报错
      const wbClient = proxy.client || {}
      const mitm = status.mitmproxy || {}
      const ca = status.ca || {}
      const session = status.session || {}
      const py = status.python || {}
      const lanSt = status.lan || null
      const captured = Boolean(health && health.capture && health.capture.captured)
      const authReady = Boolean(health && health.authReady)
      // /health.credentials 是凭证体检的唯一来源；老版本 bridge 没有这个字段时退化处理
      const cred = (health && health.credentials) || {
        ready: authReady,
        capture: (health && health.capture) || { captured: false },
        needsCapture: !authReady,
      }
      const logs = (status.logs || []).slice(-8)
      const mitmLabel = mitm.installed
        ? `已安装 ${mitm.version || ''}`
        : mitm.broken
          ? '装过但虚拟环境失效（换过 Python / 换过机器）'
          : '未安装'

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 } },

        h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, color: C.label } }, 'WorkBuddy'),
        h('p', { style: { margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.6 } },
          '把 WorkBuddy 订阅模型接到本地网关：不申请 API Key，只在本机抓一次客户端会话头复用。'),

        h(Card, { title: '运行状态' },
          h(Row, { label: '网关' }, h(Dot, { ok: true, warn: !authReady }),
            health ? `${health.mode} · ${health.upstream}` : '未启动'),
          h(Row, { label: '凭证' }, h(Dot, { ok: authReady }),
            cred.ready
              ? cred.capture && cred.capture.captured
                ? `就绪 · 来自抓包 · ${cred.capture.userId || '账号未知'}`
                : '就绪 · 来自环境变量'
              : '未就绪'),
          h(Row, { label: '会话' }, h(Dot, { ok: captured }),
            captured
              ? `已捕获 · ${(cred.capture && cred.capture.userId) || '账号未知'}`
              : '尚未捕获'),
          // 正式产品只有一条取证路：抓包。缺凭证时必须把「下一步做什么」直接摆在面板上
          cred.needsCapture
            ? h('div', {
                style: {
                  marginTop: 8, padding: '8px 10px', borderRadius: 6, border: C.border,
                  background: C.cardFill, fontSize: 12, lineHeight: 1.7, color: C.sub,
                },
              },
                h('div', { style: { color: C.warn, marginBottom: 2 } },
                  (cred.capture && cred.capture.expired) ? '抓包凭证已过期' : '还没有凭证'),
                h('div', null, '① 下面「抓包环境」装好 mitmproxy 与 CA'),
                h('div', null, '②「抓包与代理」点「开始抓包」（会重启一次 WorkBuddy 并接管它的代理）'),
                h('div', null, '③ 在 WorkBuddy 里随便发一条消息，让桥抓到会话头'),
                h('div', null, '④ 回来点「停止并还原」，此处的凭证会变成「就绪」'))
            : null),

        h(LinkCard, {
          link,
          busy,
          lan: link && link.lan,
          onCopy: copy,
          onRefetch: act('link', async () => {
            await loadLink()
            return { ok: true }
          }),
        }),

        h(LanCard, { lan: lanSt, busy, act, copy }),
        h(KeysCard, {
          lan: lanSt,
          busy,
          act,
          actRaw,
          copy,
          newKey,
          setNewKey,
          keyName,
          setKeyName,
          verifyInput,
          setVerifyInput,
          verifyResult,
        }),
        h(ApisCard, { lan: lanSt, busy, act }),

        h(Card, { title: '抓包环境' },
          h(Row, { label: 'Python' }, py.found ? `${py.version}（${py.cmd}）` : '未找到，请先安装 Python 3.10+'),
          h(Row, {
            label: 'mitmproxy',
            copy: h(Btn, {
              onClick: act('install', () => api('/setup/install', 'POST')),
              busy: busy === 'install' || Boolean(install.running),
              disabled: !py.found,
              kind: mitm.installed ? undefined : 'primary',
            }, install.running ? `安装中 · ${PHASE[install.phase] || install.phase}` : mitm.installed ? '重新安装' : mitm.broken ? '重建环境' : '安装 mitmproxy'),
          }, h(Dot, { ok: Boolean(mitm.installed), warn: Boolean(mitm.broken) }), mitmLabel),
          h(Row, {
            label: 'CA 证书',
            copy: h('span', { style: { display: 'flex', gap: 6 } },
              h(Btn, {
                onClick: act('ca', () => api('/setup/ca', 'POST')),
                busy: busy === 'ca',
                kind: ca.installed ? undefined : 'primary',
              }, ca.installed ? '重新安装' : '安装到本机'),
              h(Btn, {
                onClick: act('recheck', () => refresh(true)),
                busy: busy === 'recheck',
                title: '证书是刚手动装的？点这里重新读一次证书库',
              }, '重新检测')),
          }, h(Dot, { ok: Boolean(ca.installed) }),
          ca.installed
            ? '已信任'
            : ca.exists
              ? ca.bundled
                ? '随包附带，未信任'
                : '已生成，未信任'
              : '未生成'),
          h('div', { style: { fontSize: 11, color: C.muted, lineHeight: 1.6, marginTop: 4 } },
            '证书随安装包附带（bridge/certs），不用先抓一次包去生成；mitmproxy 装在 bridge/.tools/mitm 的独立虚拟环境里，不动系统 Python。CA 装进「当前用户」根证书库（certutil -user，免管理员）。'),
          !ca.installed && ca.exists
            ? h('div', {
                style: {
                  marginTop: 6, padding: '8px 10px', borderRadius: 6, border: C.border,
                  background: C.cardFill, fontSize: 11, color: C.sub, lineHeight: 1.7, wordBreak: 'break-all',
                },
              },
                h('div', null, '「安装到本机」被安全策略拦下时，双击 ', h('span', { style: { fontFamily: MONO } }, ca.script || 'bridge\\certs\\install-ca.cmd'), '，回来点「重新检测」。'),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' } },
                  h(Btn, { onClick: () => copy(`certutil -user -addstore -f Root "${ca.file}"`, '命令已复制，粘贴到命令提示符即可') }, '复制命令'),
                  h('span', { style: { fontFamily: MONO, color: C.muted } }, ca.file)))
            : null,
          install.error
            ? h('div', { style: { fontSize: 12, color: C.bad, marginTop: 4, lineHeight: 1.6 } }, install.error)
            : null,
          mitm.broken && mitm.error
            ? h('div', { style: { fontSize: 12, color: C.warn, marginTop: 4, lineHeight: 1.6, fontFamily: MONO, wordBreak: 'break-all' } }, mitm.error)
            : null),

        h(Card, { title: '抓包与代理' },
          h(Row, { label: 'mitmdump' }, h(Dot, { ok: Boolean(capture.running) }),
            capture.running ? `运行中 :${capture.port}` : '未运行'),
          h(Row, {
            label: '客户端接管',
            copy: h(Btn, {
              onClick: act('proxy', () => api('/proxy', 'POST', { enabled: !proxy.enabled })),
              busy: busy === 'proxy',
            }, proxy.enabled ? '恢复客户端' : '接管客户端'),
          }, h(Dot, { ok: Boolean(proxy.enabled), warn: !proxy.enabled }),
          proxy.enabled
            ? `已接管 → ${proxy.server || 'http://127.0.0.1:' + capture.port}`
            : wbClient.running ? '未接管' : '未接管（客户端没在跑）'),
          proxy.orphan
            ? h('div', { style: { fontSize: 12, color: C.warn, marginTop: 4, lineHeight: 1.6 } },
                '上次接管没收尾（记录的那个进程已经不在）：点「恢复客户端」清掉状态，再重新开始抓包。')
            : null,
          wbClient.found === false
            ? h('div', { style: { fontSize: 12, color: C.bad, marginTop: 4, lineHeight: 1.6, wordBreak: 'break-all' } },
                '没找到 WorkBuddy.exe。用环境变量 WORKBUDDY_CLIENT_EXE 指到安装路径后重启 DSH。')
            : wbClient.exe
              ? h('div', { style: { fontSize: 11, color: C.muted, marginTop: 2, wordBreak: 'break-all' } },
                  wbClient.exe)
              : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h(Btn, {
              onClick: act('start', () => api('/capture/start', 'POST', { proxy: true })),
              busy: busy === 'start',
              disabled: !mitm.installed || Boolean(capture.running),
              kind: 'primary',
            }, '开始抓包'),
            h(Btn, {
              onClick: act('stop', () => api('/capture/stop', 'POST', { proxy: true })),
              busy: busy === 'stop',
              disabled: !capture.running && !proxy.enabled,
            }, '停止并还原')),
          h('div', { style: { fontSize: 11, color: C.muted, lineHeight: 1.6, marginTop: 6 } },
            '「开始抓包」会重启一次 WorkBuddy，并给它注入 HTTP_PROXY=127.0.0.1:8899（客户端启动时自己调 session.setProxy，只作用于它自己）—— 不写注册表、不改系统代理、不需要管理员。重启后去 WorkBuddy 里发一条消息；点「停止并还原」会关掉这份进程，再按接管前的环境帮你打开。')),

        h(Card, { title: '会话记忆' },
          h(Row, { label: '当前会话' },
            h(Dot, { ok: Boolean(session.captured) && !session.expired, warn: Boolean(session.captured) && session.expired }),
            !session.captured
              ? '未捕获'
              : session.expired
                ? `已过期（${session.expiresAt || '时间未知'}）`
                : `${session.source || '抓包'} · ${session.domain || '上游'} · 有效至 ${session.expiresAt || '未知'}`),
          h(Row, {
            label: '记住会话',
            copy: h(Btn, {
              onClick: act('persist', () => api('/setup/session', 'POST', { persist: !session.persist })),
              busy: busy === 'persist',
            }, session.persist ? '关闭' : '开启'),
          },
          h(Dot, { ok: Boolean(session.persist), warn: !session.persist }),
          session.persist
            ? (session.persisted ? '已开启（会话已落盘）' : '已开启（抓到会话后落盘）')
            : '已关闭（只存内存）'),
          h('div', { style: { fontSize: 11, color: C.muted, lineHeight: 1.7, marginTop: 6 } },
            '关闭时凭证只存在网关内存里：重装插件或重启 DSH 都会换一份网关进程，之后要重新抓一次。',
            '开启后会写入 ',
            h('span', { style: { fontFamily: MONO } }, 'bridge/.session.json'),
            '（权限 0600，已 gitignore），网关重启仍能复用，直到令牌到期。只在自己的机器上开。')),

        note && note.text
          ? h('div', { style: { fontSize: 12, color: note.bad ? C.bad : C.ok, lineHeight: 1.6 } }, note.text)
          : null,

        logs.length
          ? h('details', { style: { fontSize: 12 } },
            h('summary', { style: { cursor: 'pointer', color: C.muted } }, '日志'),
            h('pre', {
              style: {
                fontSize: 11, fontFamily: MONO, whiteSpace: 'pre-wrap', marginTop: 6,
                padding: 10, borderRadius: 8, border: C.border, maxHeight: 220, overflow: 'auto', color: C.sub,
              },
            }, logs.join('\n')))
          : null)
    }

    function SafePanel() {
      return h(Boundary, null, h(Panel))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'workbuddy',
          order: 50,
          label: () => 'WorkBuddy',
        }, SafePanel))
      },
    }
  },
})
