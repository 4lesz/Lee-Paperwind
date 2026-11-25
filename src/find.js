import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { icons } from './icons.js'
import { toast } from './ui.js'

// 查找替换（设计规范 §4.15，验收标准 §8g）
// 范围只限当前文档渲染出来的文字：Markdown 标记、链接地址、属性区都不参与匹配。

const MAX_HITS = 1200 // 大文档里最多画这么多处高亮，计数仍按真实总数
const DEBOUNCE = 150

const $ = (id) => document.getElementById(id)

export function createFind({ editor, scroller, getMode, onNeedEdit }) {
  const pluginKey = new PluginKey('find-highlights')

  // 高亮插件：装饰由下面的 dispatch 更新，文档改动时跟着平移，避免每次按键都重扫
  const plugin = new Plugin({
    key: pluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const meta = tr.getMeta(pluginKey)
        if (meta) {
          return DecorationSet.create(
            tr.doc,
            meta.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: i === meta.current ? 'find-hit find-current' : 'find-hit',
              })
            )
          )
        }
        return tr.docChanged ? old.map(tr.mapping, tr.doc) : old
      },
    },
    props: {
      decorations(state) {
        return pluginKey.getState(state)
      },
    },
  })
  editor.registerPlugin(plugin)

  const bar = $('findbar')
  const input = $('findInput')
  const countEl = $('findCount')
  const prevBtn = $('findPrev')
  const nextBtn = $('findNext')
  const toggleBtn = $('findToggle')
  const closeBtn = $('findClose')
  const row = $('replaceRow')
  const replaceInput = $('replaceInput')
  const replaceOneBtn = $('replaceOne')
  const replaceAllBtn = $('replaceAll')

  prevBtn.innerHTML = icons.up
  nextBtn.innerHTML = icons.down
  closeBtn.innerHTML = icons.close

  let matches = [] // [{ from, to }]，全文范围内的真实结果
  let current = -1
  let query = ''
  let lastDoc = null // 上次扫描时的文档，用来判断结果是否已过期
  let lastQuery = null
  let timer = 0

  // ---------------- 扫描 ----------------
  // 每个文字块（段落、标题、代码块、表格单元格里的段落…）内拼接文字再匹配：
  // 跨格式（加粗、链接文字）能匹配到，段落之间、图片和换行处断开。
  function scan(doc, text) {
    const needle = text.toLowerCase()
    const out = []
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      let segStart = -1
      let segText = ''
      const flush = () => {
        if (segText) {
          const lower = segText.toLowerCase()
          let i = lower.indexOf(needle)
          while (i !== -1) {
            out.push({ from: segStart + i, to: segStart + i + needle.length })
            i = lower.indexOf(needle, i + needle.length)
          }
        }
        segStart = -1
        segText = ''
      }
      node.descendants((child, childPos) => {
        if (child.isText) {
          if (segStart < 0) segStart = pos + 1 + childPos
          segText += child.text
        } else if (child.isInline) {
          flush()
        }
      })
      flush()
      return false
    })
    return out
  }

  // ---------------- 高亮 ----------------
  function paint() {
    const n = matches.length
    countEl.textContent = !query ? '0/0' : n ? `${current + 1}/${n}` : '无结果'
    prevBtn.disabled = nextBtn.disabled = replaceOneBtn.disabled = replaceAllBtn.disabled = !n
    let list = matches
    let offset = 0
    if (n > MAX_HITS) {
      const half = Math.floor(MAX_HITS / 2)
      offset = Math.min(Math.max(0, (current < 0 ? 0 : current) - half), n - MAX_HITS)
      list = matches.slice(offset, offset + MAX_HITS)
    }
    editor.view.dispatch(
      editor.state.tr.setMeta(pluginKey, { matches: list, current: current < 0 ? -1 : current - offset })
    )
  }

  function revealCurrent() {
    const m = matches[current]
    if (!m) return
    const view = editor.view
    const box = scroller.getBoundingClientRect()
    let coords
    try {
      coords = view.coordsAtPos(m.from)
    } catch {
      return // 位置所在节点暂时没有渲染（如折叠的 HTML 块），不做滚动
    }
    const top = box.top + 120 // 上方让开格式栏
    const bottom = box.bottom - 48
    if (coords.top < top || coords.bottom > bottom) {
      scroller.scrollTo({ top: scroller.scrollTop + coords.top - box.top - box.height / 2, behavior: 'smooth' })
    }
  }

  // ---------------- 搜索 ----------------
  // anchor：从哪个文档位置往后找；没给时沿用当前匹配，再没有就用光标位置。
  function runSearch({ anchor, reveal = false } = {}) {
    const prev = matches[current]
    const at = anchor !== undefined ? anchor : prev ? prev.from : null
    query = input.value
    matches = query ? scan(editor.state.doc, query) : []
    lastDoc = editor.state.doc
    lastQuery = query
    current = -1
    if (matches.length) {
      const from = at == null ? editor.state.selection.from : at
      const i = matches.findIndex((m) => m.to >= from)
      current = i === -1 ? 0 : i
    }
    paint()
    if (reveal) revealCurrent()
  }

  // 文档被改动过或输入框里的内容还没扫描：重新扫一遍，保证替换位置准确
  function ensureFresh() {
    if (editor.state.doc !== lastDoc || input.value !== lastQuery) runSearch({ anchor: null })
  }

  function go(dir) {
    if (!matches.length) return
    current = (current + dir + matches.length) % matches.length
    paint()
    revealCurrent()
  }

  // ---------------- 替换 ----------------
  function replaceOne() {
    ensureFresh()
    const m = matches[current]
    if (!m) return
    const text = replaceInput.value
    editor.view.dispatch(editor.state.tr.insertText(text, m.from, m.to))
    runSearch({ anchor: m.from + text.length, reveal: true }) // 自动跳到下一处
    replaceInput.focus()
  }

  function replaceAll() {
    ensureFresh()
    if (!matches.length) return
    const list = matches
    const text = replaceInput.value
    const tr = editor.state.tr
    for (let i = list.length - 1; i >= 0; i--) tr.insertText(text, list[i].from, list[i].to) // 倒序，位置不受影响
    editor.view.dispatch(tr) // 一个事务，Ctrl+Z 一步还原
    toast(`已全部替换，共 ${list.length} 处`)
    runSearch({ anchor: 0, reveal: true })
    replaceInput.focus()
  }

  // ---------------- 打开与关闭 ----------------
  function setReplace(on) {
    row.hidden = !on
    toggleBtn.classList.toggle('on', on)
    toggleBtn.setAttribute('aria-expanded', on ? 'true' : 'false')
  }

  function open({ replace = false } = {}) {
    const mode = getMode()
    if (mode === 'source' || (replace && mode === 'read')) onNeedEdit()
    const wasOpen = !bar.hidden
    bar.hidden = false
    if (replace) setReplace(true)
    if (!wasOpen) runSearch({ anchor: null, reveal: true })
    if (replace) replaceInput.focus()
    else {
      input.focus()
      input.select()
    }
  }

  function close({ refocus = true } = {}) {
    if (bar.hidden) return
    clearTimeout(timer)
    bar.hidden = true
    setReplace(false)
    matches = []
    current = -1
    lastDoc = lastQuery = null
    countEl.textContent = '0/0'
    editor.view.dispatch(editor.state.tr.setMeta(pluginKey, { matches: [], current: -1 }))
    if (refocus && getMode() === 'edit') editor.commands.focus(undefined, { scrollIntoView: false })
  }

  // 输入时防抖刷新；文档改动时也重新扫一遍（§8g Q04）
  function scheduleSearch() {
    clearTimeout(timer)
    timer = setTimeout(() => runSearch({ reveal: true }), DEBOUNCE)
  }

  function onDocChange() {
    if (bar.hidden || !input.value) return
    clearTimeout(timer)
    timer = setTimeout(() => runSearch({ anchor: null }), DEBOUNCE)
  }

  // ---------------- 事件 ----------------
  input.addEventListener('input', scheduleSearch)
  input.addEventListener('focus', () => input.select())
  replaceInput.addEventListener('focus', () => replaceInput.select())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      go(e.shiftKey ? -1 : 1)
    }
  })
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      replaceOne()
    }
  })
  prevBtn.addEventListener('click', () => go(-1))
  nextBtn.addEventListener('click', () => go(1))
  closeBtn.addEventListener('click', () => close())
  replaceOneBtn.addEventListener('click', () => replaceOne())
  replaceAllBtn.addEventListener('click', () => replaceAll())
  toggleBtn.addEventListener('click', () => {
    const on = row.hidden
    setReplace(on)
    if (on) replaceInput.focus()
  })

  // Esc：焦点在查找条里或在正文里都关闭，回到编辑（§8g Q01）
  window.addEventListener(
    'keydown',
    (e) => {
      if (bar.hidden || e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    },
    true
  )

  return {
    open,
    close,
    onDocChange,
    isOpen: () => !bar.hidden,
  }
}