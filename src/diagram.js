// 流程图（Mermaid）：语言为 mermaid 的代码块画成图（设计规范 §5.2，AC-W03–W07）
// 做法：不改代码块本身，只加两种装饰——
//   1. 代码块上的类名：光标不在里面时把代码收起（mermaid-editing / mermaid-error 时展开）；
//   2. 代码块后面的一个小部件：放画好的图。
// 渲染组件只在文档里有流程图时才载入（动态 import，打包成单独的文件）。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const key = new PluginKey('mermaidDiagram')
const DEBOUNCE = 300
const MIN_SCALE = 0.8

let mermaidPromise = null
let queue = Promise.resolve()
let seq = 0
const results = new Map() // `${主题}\n${代码}` → { svg } | { error }
const lastShown = new Map() // 第几个流程图 → 上次显示的内容（新图画好前先显示旧图，避免闪烁）

const isMermaid = (node) => node.type.name === 'codeBlock' && /^mermaid$/i.test(node.attrs.language || '')

export function isDarkTheme() {
  const t = document.documentElement.dataset.theme
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
}
const themeKey = () => (isDarkTheme() ? 'dark' : 'light')

// 把设计变量解析成具体颜色；半透明的颜色叠在正文底色上，得到不透明的颜色
function resolveColors() {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const get = (v) => {
    probe.style.color = `var(${v})`
    return getComputedStyle(probe).color
  }
  const parse = (c) => (c.match(/[\d.]+/g) || [0, 0, 0, 1]).map(Number)
  const bg = parse(get('--bg-content'))
  const over = (v) => {
    const [r, g, b, a = 1] = parse(get(v))
    const m = (x, y) => Math.round(x * a + y * (1 - a))
    return `rgb(${m(r, bg[0])}, ${m(g, bg[1])}, ${m(b, bg[2])})`
  }
  const out = {
    content: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`,
    card: over('--fill-secondary'),
    text: over('--text'),
    secondary: over('--text-secondary'),
    tertiary: over('--text-tertiary'),
    accentFill: over('--accent-fill'),
    font: getComputedStyle(document.body).fontFamily,
  }
  probe.remove()
  return out
}

function config() {
  const c = resolveColors()
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    logLevel: 'fatal',
    suppressErrorRendering: true,
    // 标签用 SVG 文字而不是 HTML：图里写的 HTML 标签只当文字，任何属性都不会进入页面（AC-W06）
    htmlLabels: false,
    theme: 'base',
    darkMode: isDarkTheme(),
    fontFamily: c.font,
    themeVariables: {
      darkMode: isDarkTheme(),
      background: c.card,
      fontFamily: c.font,
      fontSize: '14px',
      primaryColor: c.content,
      primaryTextColor: c.text,
      primaryBorderColor: c.tertiary,
      secondaryColor: c.accentFill,
      tertiaryColor: c.card,
      lineColor: c.secondary,
      textColor: c.text,
      edgeLabelBackground: c.card,
      clusterBkg: c.card,
      clusterBorder: c.tertiary,
      noteBkgColor: c.accentFill,
      noteTextColor: c.text,
      noteBorderColor: c.tertiary,
      actorBkg: c.content,
      actorBorder: c.tertiary,
      actorTextColor: c.text,
      signalColor: c.secondary,
      signalTextColor: c.text,
    },
    // 判断节点（菱形）用强调色的浅底
    // 节点圆角、去掉默认阴影（深色下会发光），与设计规范 §3.4 的圆润风格一致
    themeCSS: `.node polygon { fill: ${c.accentFill} !important; }
      .node rect, .node polygon, .node circle, .node path, .actor { filter: none !important; }
      .node rect, rect.actor, rect.note { rx: 8px; ry: 8px; }`,
  }
}

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      window.__mermaidLoaded = true
      return m.default
    })
  }
  return mermaidPromise
}

// 交给 mermaid 之前去掉标签里的 on… 事件属性和 javascript: 地址：mermaid 量文字尺寸时会把标签临时放进页面，
// 虽然页面的 CSP 会拦下脚本，但不应该让它有机会出现（AC-W06）。只影响画图，文件原样不动。
export function defang(code) {
  let prev
  let s = code
  do {
    prev = s
    s = s.replace(/(<[a-z][^>]*?)\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1')
  } while (s !== prev)
  return s.replace(/javascript\s*:/gi, 'blocked:')
}

// 一次只画一张（mermaid 的渲染不能并发）
function render(code, theme) {
  const k = `${theme}\n${code}`
  if (results.has(k)) return Promise.resolve(results.get(k))
  const job = queue.then(async () => {
    if (results.has(k)) return results.get(k)
    const mermaid = await loadMermaid()
    mermaid.initialize(config())
    const id = `mermaid-${++seq}`
    let r
    try {
      const { svg } = await mermaid.render(id, defang(code))
      r = { svg }
    } catch (e) {
      const msg = String((e && (e.message || e.str)) || e).split('\n').find((l) => l.trim()) || '无法识别'
      r = { error: msg.trim() }
    } finally {
      document.getElementById(id)?.remove()
      document.getElementById('d' + id)?.remove()
    }
    results.set(k, r)
    if (results.size > 200) results.delete(results.keys().next().value)
    return r
  })
  queue = job.catch(() => {})
  return job
}

function fill(body, r) {
  if (r.svg) {
    body.innerHTML = r.svg
    body.classList.remove('is-error')
    // 比正文宽时先缩小，但最多缩到原来的 80%（字不能小到看不清），再宽就左右滚动（设计规范 §5.2）
    const svg = body.querySelector('svg')
    const vb = svg?.viewBox?.baseVal
    if (vb && vb.width) {
      svg.style.width = '100%'
      svg.style.maxWidth = `${Math.round(vb.width)}px`
      svg.style.minWidth = `${Math.round(vb.width * MIN_SCALE)}px`
      svg.style.height = 'auto'
    }
  } else {
    body.textContent = ''
    const p = document.createElement('div')
    p.className = 'mermaid-error-msg'
    p.textContent = `流程图有误：${r.error}`
    body.appendChild(p)
    body.classList.add('is-error')
  }
}

function widget(view, index, code, theme) {
  const box = document.createElement('div')
  box.className = 'mermaid-view'
  box.contentEditable = 'false'
  box.dataset.index = String(index)
  const body = document.createElement('div')
  body.className = 'mermaid-body'
  box.appendChild(body)

  const k = `${theme}\n${code}`
  const done = results.get(k)
  const draw = () =>
    render(code, theme).then((r) => {
      if (!box.isConnected && box._destroyed) return
      fill(body, r)
      lastShown.set(index, r)
      box.dataset.state = r.svg ? 'ok' : 'error'
      // 错误状态影响代码是否展开，需要重新计算装饰
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, 'refresh'))
    })
  if (done) {
    fill(body, done)
    box.dataset.state = done.svg ? 'ok' : 'error'
    lastShown.set(index, done)
  } else {
    const prev = lastShown.get(index)
    box.dataset.state = 'pending'
    if (prev) {
      fill(body, prev)
      box._timer = setTimeout(draw, DEBOUNCE)
    } else {
      body.classList.add('is-pending')
      draw()
    }
  }
  return box
}

export const MermaidDiagram = Extension.create({
  name: 'mermaidDiagram',
  addProseMirrorPlugins() {
    const build = (state) => {
      const decos = []
      const sel = state.selection
      let index = 0
      const theme = themeKey()
      state.doc.descendants((node, pos) => {
        if (!isMermaid(node)) return node.isBlock
        const code = node.textContent
        const r = results.get(`${theme}\n${code}`)
        const editing = sel.from > pos && sel.from < pos + node.nodeSize
        const cls = ['mermaid-src', editing && 'mermaid-editing', r && r.error && 'mermaid-error'].filter(Boolean).join(' ')
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls }))
        const i = index++
        decos.push(
          Decoration.widget(pos + node.nodeSize, (view) => widget(view, i, code, theme), {
            side: -1,
            key: `mermaid-${i}-${theme}-${code}`,
            ignoreSelection: true,
            destroy: (dom) => {
              dom._destroyed = true
              clearTimeout(dom._timer)
            },
          }),
        )
        return false
      })
      return DecorationSet.create(state.doc, decos)
    }
    return [
      new Plugin({
        key,
        state: {
          init: (_c, state) => build(state),
          apply: (tr, old, oldState, state) => {
            // 整篇换掉（载入另一篇）时，不再沿用上一篇的图作为过渡
            if (tr.docChanged && tr.steps.some((s) => s.from === 0 && s.to === oldState.doc.content.size)) lastShown.clear()
            return tr.docChanged || tr.selectionSet || tr.getMeta(key) ? build(state) : old
          },
        },
        props: {
          decorations: (state) => key.getState(state),
          handleDOMEvents: {
            // 编辑模式下单击图：光标移进代码末尾，代码展开
            mousedown(view, event) {
              const box = event.target.closest?.('.mermaid-view')
              if (!box || !view.editable) return false
              event.preventDefault()
              const pos = view.posAtDOM(box, 0)
              const $end = view.state.doc.resolve(Math.max(0, pos - 1))
              view.dispatch(view.state.tr.setSelection(TextSelection.near($end, -1)))
              view.focus()
              return true
            },
          },
        },
        view(view) {
          // 切换深浅色时重画
          const refresh = () => !view.isDestroyed && view.dispatch(view.state.tr.setMeta(key, 'theme'))
          const mo = new MutationObserver(refresh)
          mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
          const mq = matchMedia('(prefers-color-scheme: dark)')
          mq.addEventListener('change', refresh)
          return {
            destroy() {
              mo.disconnect()
              mq.removeEventListener('change', refresh)
            },
          }
        },
      }),
    ]
  },
})
