/**
 * Client half of Session sync.
 *
 * One 14 px logo in front of every Session title states where the session came
 * from. The source map arrives once from the Host status route; each logo
 * subscribes to that one store, so a late answer re-renders every mounted row.
 * There is no per-row fetch, no polling, and no session-log read.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-sync',
  factory: (require) => {
    const React = require('react')

    /** Must match the Host row's `endpoint`. */
    const ENDPOINT = '/plugins/session-sync'
    /** Optional hidden element the Host may inject into a web index. */
    const SOURCES_ELEMENT_ID = 'dsh-session-sync-sources'

    /** One source map for every row; replaced wholesale when an answer lands. */
    let sources = {}
    let version = 0
    const listeners = new Set()

    /** Publish a new map and wake every subscribed logo. */
    function publish(next) {
      sources = next !== null && typeof next === 'object' && !Array.isArray(next) ? next : {}
      version += 1
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          /* one bad subscriber must not break the rest */
        }
      }
    }

    /** Subscribe to map changes. */
    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    /** Version number used by `useSyncExternalStore`. */
    function getSnapshot() {
      return version
    }

    /** Read the Host-injected map when a web index carries one. */
    function injectedSources() {
      try {
        const element = document.getElementById(SOURCES_ELEMENT_ID)
        if (element === null) return null
        const encoded = element.getAttribute('data-sources') ?? ''
        if (encoded.length === 0) return null
        const parsed = JSON.parse(atob(encoded))
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    }

    /** Fetch the Host status route once, falling back to an injected map. */
    async function loadSources() {
      try {
        const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
        if (response.ok) {
          const body = await response.json()
          const map = body?.sources
          if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
            publish(map)
            return
          }
        }
      } catch {
        /* fall through to the injected map */
      }
      const injected = injectedSources()
      if (injected !== null) publish(injected)
    }

    /**
     * Original marks; no third-party artwork, safe to redistribute.
     *
     * The letters are drawn as SVG paths rather than text so every row has the
     * same pixel size independent of the interface font.
     */
    const LOGOS = {
      dsh: {
        label: 'DSH session',
        node: React.createElement(
          'svg',
          { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
          React.createElement('rect', { x: 0, y: 0, width: 16, height: 16, rx: 4, fill: '#4D6BFE' }),
          React.createElement('path', {
            d: 'M5 4.6h2.6a3.4 3.4 0 0 1 0 6.8H5z',
            fill: 'none',
            stroke: '#fff',
            strokeWidth: 1.5,
            strokeLinejoin: 'round',
          }),
        ),
      },
      'claude-code': {
        label: 'From Claude Code',
        node: React.createElement(
          'svg',
          { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
          React.createElement('rect', { x: 0, y: 0, width: 16, height: 16, rx: 4, fill: '#D97757' }),
          React.createElement('path', {
            d: 'M8 3.1v9.8M3.1 8h9.8M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8',
            fill: 'none',
            stroke: '#fff',
            strokeWidth: 1.25,
            strokeLinecap: 'round',
          }),
        ),
      },
      'minimax-code': {
        label: 'From MiniMax Code',
        node: React.createElement(
          'svg',
          { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
          React.createElement('rect', { x: 0, y: 0, width: 16, height: 16, rx: 4, fill: '#6C4BF6' }),
          React.createElement('path', {
            d: 'M3.8 11.4V4.9l4.2 4.2 4.2-4.2v6.5',
            fill: 'none',
            stroke: '#fff',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      },
    }

    /** The hook that makes every logo follow the one shared map. */
    function useSource(sessionId) {
      if (typeof React.useSyncExternalStore === 'function') {
        React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      } else {
        const [, setTick] = React.useState(0)
        React.useEffect(() => subscribe(() => setTick((tick) => tick + 1)), [])
      }
      return sources[sessionId] ?? 'dsh'
    }

    /** One source logo; the row supplies only its Session id. */
    function SourceLogo({ sessionId }) {
      const source = useSource(sessionId)
      const meta = LOGOS[source] ?? LOGOS.dsh
      return React.createElement(
        'span',
        {
          className: 'dshss_logo',
          title: meta.label,
          'aria-label': meta.label,
          'data-session-source': source,
        },
        meta.node,
      )
    }

    const css = [
      '.dshss_logo{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none;line-height:0;vertical-align:middle;border-radius:4px;overflow:hidden}',
      '.dshss_logo svg{display:block;width:14px;height:14px}',
    ].join('')

    const apply = (ctx) => {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, 'session-sync: logo styles')

      // One delayed load: the slot mounts immediately and every logo updates
      // when the map arrives.
      ctx.effect(() => {
        void loadSources()
        return () => {}
      }, 'session-sync: source load')

      ctx.slots.inject('sidebar.session.row.leading', () =>
        ctx.slots.register(
          {
            name: 'sidebar.session.row.leading',
            id: 'session-sync-logo',
            order: 5,
            label: 'Session source',
          },
          SourceLogo,
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
