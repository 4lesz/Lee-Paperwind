// 属性区（front matter）与翻页索引（设计规范 §4.13b）
//
// 文档最开头用两行 --- 包起来的一段是「属性区」。编辑器把它当成一个不可直接编辑的节点：
// 原文逐字保存；编辑模式显示为「属性 · 键名」小标签，阅读模式隐藏。
// 其中的 prev / next 两个键就是翻页索引：指定上一篇 / 下一篇翻到哪一篇。
import { Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

export const FM_META = 'frontMatter' // 带这个标记的修改才允许改动属性区

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const isFence = (s) => /^---[ \t]*$/.test(s)
const isClose = (s) => /^(---|\.\.\.)[ \t]*$/.test(s)
// 一行 YAML 键：「键: 值」或「键:」
const KEY_LINE = /^["']?[^\s:#'"][^:\n]*["']?:(\s|$)/

// ---------------- markdown-it：只在文档第一行识别 ----------------
function frontMatterRule(state, startLine, endLine, silent) {
  if (startLine !== 0 || state.parentType !== 'root' || state.level !== 0) return false
  const line = (n) => state.src.slice(state.bMarks[n], state.eMarks[n])
  if (state.bMarks[0] !== 0 || !isFence(line(0))) return false
  let close = -1
  let keyed = false
  for (let n = 1; n < endLine; n++) {
    const l = line(n)
    if (isClose(l)) {
      close = n
      break
    }
    // 第一行有内容的地方必须像 YAML 的「键:」，避免把「分隔线 + 段落 + 分隔线」误认成属性区
    if (!keyed && l.trim() && !/^\s*#/.test(l)) {
      if (!KEY_LINE.test(l)) return false
      keyed = true
    }
  }
  if (close < 0 || !keyed) return false
  if (silent) return true
  const token = state.push('front_matter', '', 0)
  token.block = true
  token.map = [0, close + 1]
  token.content = state.src.slice(0, state.eMarks[close]).replace(/\r/g, '')
  state.line = close + 1
  return true
}

function setupParser(md) {
  if (md.__frontMatter) return
  md.__frontMatter = true
  md.block.ruler.before('table', 'front_matter', frontMatterRule)
  md.renderer.rules.front_matter = (tokens, idx) =>
    `<div data-type="front-matter" data-raw="${escapeAttr(tokens[idx].content)}"></div>\n`
}

// ---------------- 读取：属性区里的键、prev / next ----------------
const unquote = (v) => {
  v = v.trim()
  if (/^".*"$/.test(v)) {
    try {
      return JSON.parse(v)
    } catch {
      return v.slice(1, -1)
    }
  }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'")
  return v
}
// 去掉行尾注释（YAML 的注释要求 # 前面有空格，所以 附录.md#人物表 不受影响）
const stripComment = (v) => (/^["']/.test(v.trim()) ? v : v.replace(/\s+#.*$/, ''))

function contentLines(raw) {
  const lines = raw.split('\n')
  return lines.slice(1, lines.length - 1)
}

// 顶层键名（显示在「属性」小标签上）
export function frontMatterKeys(raw) {
  const keys = []
  for (const l of contentLines(raw || '')) {
    const m = /^(["']?)([^\s:#'"][^:\n]*?)\1:(\s|$)/.exec(l)
    if (m) keys.push(m[2].trim())
  }
  return keys
}

// 解析一个翻页键的值：{ hide: true } | { link, text } | undefined（未指定，按默认顺序）
function parseEntry(lines, i) {
  const m = /^(prev|next)\s*:(.*)$/.exec(lines[i])
  let v = stripComment(m[2]).trim()
  const sub = {}
  if (v === '' || v === '|' || v === '>') {
    // 分行缩进写法：  text: …  /  link: …
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) {
      const s = /^\s+(text|link)\s*:(.*)$/.exec(lines[j])
      if (s) sub[s[1]] = unquote(stripComment(s[2]))
    }
  } else if (v.startsWith('{') && v.endsWith('}')) {
    // 行内写法：{ text: …, link: … }
    const re = /(text|link)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,}]*)/g
    let s
    while ((s = re.exec(v.slice(1, -1)))) sub[s[1]] = unquote(s[2])
  } else {
    if (/^false$/i.test(v)) return { hide: true }
    if (/^(null|~)$/i.test(v)) return undefined
    sub.link = unquote(v)
  }
  if (sub.link === undefined || /^false$/i.test(String(sub.link))) {
    return sub.link !== undefined ? { hide: true } : undefined
  }
  const link = String(sub.link).trim()
  if (!link) return undefined
  return { link, text: sub.text ? String(sub.text).trim() : '' }
}

export function parseIndex(raw) {
  const out = {}
  if (!raw) return out
  const lines = contentLines(raw)
  lines.forEach((l, i) => {
    const m = /^(prev|next)\s*:/.exec(l)
    if (m && !(m[1] in out)) out[m[1]] = parseEntry(lines, i)
  })
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

// ---------------- 写入：只增删改 prev / next 这一项，其余逐字保留 ----------------
const needsQuote = (s) =>
  !s || /^[\s'"[\]{}>|*&!%@`#,?:-]/.test(s) || /: |\s#|\s$/.test(s) || /^(true|false|yes|no|on|off|null|~)$/i.test(s)
const yamlValue = (v) => (v === false ? 'false' : needsQuote(v) ? JSON.stringify(v) : v)

// value：字符串（相对路径）= 指定；false = 不显示；undefined = 恢复默认顺序（删掉这一项）
// 返回新的属性区原文；属性区里已没有任何内容时返回 null（整个属性区删掉）
export function setIndexInRaw(raw, key, value) {
  const line = value === undefined ? null : `${key}: ${yamlValue(value)}`
  if (!raw) return line ? `---\n${line}\n---` : null
  const lines = raw.split('\n')
  const body = lines.slice(1, -1)
  const at = body.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l))
  if (at >= 0) {
    let end = at + 1
    while (end < body.length && /^\s+\S/.test(body[end])) end++ // 连同分行缩进的 text / link
    body.splice(at, end - at, ...(line ? [line] : []))
  } else if (line) {
    // prev 放在 next 前面；否则加在最后
    const nextAt = key === 'prev' ? body.findIndex((l) => /^next\s*:/.test(l)) : -1
    if (nextAt >= 0) body.splice(nextAt, 0, line)
    else {
      let end = body.length
      while (end > 0 && !body[end - 1].trim()) end--
      body.splice(end, 0, line)
    }
  }
  if (!body.some((l) => l.trim())) return null
  return [lines[0], ...body, lines[lines.length - 1]].join('\n')
}

// ---------------- 在整篇原文上操作（双向对应时改另一篇的文件） ----------------
// 返回 { raw: 属性区原文（LF，含两行 ---）| null, after: 属性区之后的原文（LF）, eol }
export function splitFrontMatter(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  const lf = text.replace(/\r\n/g, '\n')
  const lines = lf.split('\n')
  const none = { raw: null, after: lf, eol }
  if (!isFence(lines[0])) return none
  let close = -1
  let keyed = false
  for (let n = 1; n < lines.length; n++) {
    if (isClose(lines[n])) {
      close = n
      break
    }
    if (!keyed && lines[n].trim() && !/^\s*#/.test(lines[n])) {
      if (!KEY_LINE.test(lines[n])) return none
      keyed = true
    }
  }
  if (close < 0 || !keyed) return none
  const raw = lines.slice(0, close + 1).join('\n')
  return { raw, after: lf.slice(raw.length), eol }
}

// 在整篇原文里改 prev / next 这一项；规则与编辑器里相同（只改这一行、保持换行方式、删空时整个属性区删除）
export function setIndexInText(text, key, value) {
  const { raw, after, eol } = splitFrontMatter(text)
  const next = setIndexInRaw(raw, key, value)
  if (next === raw) return text
  let out
  if (raw === null) out = after ? `${next}\n\n${after}` : `${next}\n`
  else if (next === null) out = after.replace(/^\n+/, '')
  else out = next + after
  return eol === '\n' ? out : out.replace(/\n/g, eol)
}

// ---------------- 编辑器节点 ----------------
export const FrontMatter = Node.create({
  name: 'frontMatter',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes() {
    return {
      raw: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-raw') || '',
        renderHTML: (attrs) => ({ 'data-raw': attrs.raw }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="front-matter"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'front-matter' })]
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'front-matter'
      dom.contentEditable = 'false'
      const chip = document.createElement('span')
      chip.className = 'front-matter-chip'
      chip.title = '文档属性（点击在源码模式中查看和修改）'
      const keys = frontMatterKeys(node.attrs.raw)
      chip.textContent = keys.length ? `属性 · ${keys.join('、')}` : '属性'
      chip.addEventListener('mousedown', (e) => e.preventDefault())
      chip.addEventListener('click', () => window.dispatchEvent(new CustomEvent('front-matter-open')))
      dom.append(chip)
      return { dom, ignoreMutation: () => true, stopEvent: (e) => e.type.startsWith('mouse') || e.type === 'click' }
    }
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(node.attrs.raw)
          state.closeBlock(node)
        },
        parse: { setup: setupParser },
      },
    }
  },
  // 属性区只能整体保持在文档最前面：普通编辑（退格、全选删除、粘贴……）不会删掉、挪动或多出属性区；
  // 只有翻页索引的修改（FM_META）、撤销 / 重做和整篇载入（setContent）可以改变它
  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        key: new PluginKey('frontMatterGuard'),
        appendTransaction(trs, oldState, newState) {
          if (!trs.some((tr) => tr.docChanged)) return null
          // 撤销 / 重做（history$）恢复的是之前的合法状态，也放行
          const allowed = trs.some((tr) => tr.getMeta(FM_META) || tr.getMeta('history$') || tr.getMeta('preventUpdate') !== undefined)
          const found = []
          newState.doc.forEach((n, pos) => n.type === type && found.push({ n, pos }))
          let want
          if (allowed) want = found[0]?.n.attrs.raw ?? null
          else {
            const first = oldState.doc.firstChild
            want = first && first.type === type ? first.attrs.raw : null
          }
          const ok = want === null ? !found.length : found.length === 1 && found[0].pos === 0 && found[0].n.attrs.raw === want
          if (ok) return null
          const tr = newState.tr
          for (let i = found.length - 1; i >= 0; i--) tr.delete(found[i].pos, found[i].pos + found[i].n.nodeSize)
          if (want !== null) tr.insert(0, type.create({ raw: want }))
          if (!tr.doc.childCount) tr.insert(0, newState.schema.nodes.paragraph.create())
          return tr.setMeta(FM_META, true)
        },
      }),
    ]
  },
})
