// 原文保留（AC-G01）：没有改动过的段落，保存时原样写回文件里的原文。
//
// 编辑器把 Markdown 解析成文档树、再从文档树生成 Markdown，这一来一回难免改写写法
// （表格分隔行、列表空行、转义、链接编码……）。为了保证“打开 → 不改 → 保存”一个字都不变，
// 这里在载入时记下每个顶层块（段落、标题、列表、表格、HTML 块……）对应的原文；
// 生成 Markdown 时，内容与载入时完全相同的块直接使用原文，只有改动过的块才重新生成。
// 相邻两块都没改动时，它们之间的空行、引用式链接定义等也按原文保留。
import { Extension } from '@tiptap/core'

// markdown-it 顶层块 → 编辑器节点类型
const TOKEN_TO_NODE = {
  paragraph_open: ['paragraph'],
  heading_open: ['heading'],
  bullet_list_open: ['bulletList', 'taskList'],
  ordered_list_open: ['orderedList'],
  blockquote_open: ['blockquote'],
  fence: ['codeBlock'],
  code_block: ['codeBlock'],
  hr: ['horizontalRule'],
  table_open: ['table'],
  html_block: ['htmlBlock'],
  front_matter: ['frontMatter'],
}

const isBlank = (s) => s.trim() === ''

// 把原文切成顶层块，并与文档树的顶层节点一一对应；对应不上时返回 null（退回到完全重新生成）
export function captureSource(md, src, doc) {
  const tokens = md.parse(src, {})
  const blocks = tokens.filter((t) => t.level === 0 && t.nesting !== -1 && t.map)
  if (blocks.length !== doc.childCount) return null
  // 每一行的起始位置
  const lineStart = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStart.push(i + 1)
  const lineEnd = (l) => (l + 1 < lineStart.length ? lineStart[l + 1] - 1 : src.length) // 不含换行符
  const lines = (a, b) => src.slice(lineStart[a], b > a ? lineEnd(b - 1) : lineStart[a])
  const origs = []
  for (let i = 0; i < blocks.length; i++) {
    const t = blocks[i]
    const node = doc.child(i)
    const want = TOKEN_TO_NODE[t.type]
    if (!want || !want.includes(node.type.name)) return null
    let [a, b] = t.map
    while (b > a + 1 && isBlank(lines(b - 1, b))) b--
    let text = lines(a, b)
    if (text.endsWith('\r')) text = text.slice(0, -1)
    origs.push({ node, a, b, text, start: lineStart[a], end: lineStart[a] + text.length })
  }
  if (!origs.length) return null
  for (let i = 0; i < origs.length; i++) {
    const gapEnd = i + 1 < origs.length ? origs[i + 1].start : src.length
    origs[i].gap = src.slice(origs[i].end, gapEnd) // 与下一块之间的原文（空行、引用定义……）
    origs[i].extra = origs[i].gap.trim() // 其中非空白的部分（如 [ref]: url），块被改动时也要保住
  }
  return {
    origs,
    lead: src.slice(0, origs[0].start),
    eol: src.includes('\r\n') ? '\r\n' : '\n',
  }
}

// 按原文生成 Markdown：未改动的块用原文，改动过的块交给序列化器
export function serializeWithSource(base, doc, serializeNode) {
  if (!base) return null
  const { origs, lead, eol } = base
  const items = [] // { text, orig: 序号 | null }
  let p = 0
  const pushExtras = (from, to) => {
    for (let j = from; j < to; j++) if (origs[j].extra) items.push({ text: origs[j].extra, orig: null })
  }
  doc.forEach((child) => {
    let found = -1
    for (let j = p; j < origs.length && j < p + 400; j++) {
      const o = origs[j].node
      if (o === child || o.eq(child)) {
        found = j
        break
      }
    }
    if (found >= 0) {
      pushExtras(p, found) // 被删掉或改动的原块，其中的引用定义仍保留
      items.push({ text: origs[found].text, orig: found })
      p = found + 1
    } else {
      const text = serializeNode(child)
      items.push({ text: eol === '\n' ? text : text.replace(/\r?\n/g, eol), orig: null })
    }
  })
  pushExtras(p, origs.length)
  const parts = items.filter((it) => it.orig !== null || !isBlank(it.text))
  let out = ''
  parts.forEach((it, k) => {
    const prev = parts[k - 1]
    if (k === 0) {
      if (it.orig === 0) out += lead
      else if (!isBlank(lead)) out += lead.trim() + eol + eol
    } else if (prev.orig !== null && it.orig === prev.orig + 1) {
      out += origs[prev.orig].gap
    } else {
      // 前一块与这一块原本不相邻：前一块之后的引用定义跟在它后面
      if (prev.orig !== null && origs[prev.orig].extra) out += eol + eol + origs[prev.orig].extra
      out += eol + eol
    }
    out += it.text
  })
  const last = parts[parts.length - 1]
  if (last) {
    const lo = last.orig !== null ? origs[last.orig] : null
    if (lo && last.orig === origs.length - 1) out += lo.gap
    else {
      if (lo && lo.extra) out += eol + eol + lo.extra
      const tail = origs[origs.length - 1].gap
      if (/\n$/.test(tail)) out += eol
    }
  }
  return out
}

export const SourcePreserve = Extension.create({
  name: 'sourcePreserve',
  addStorage() {
    return { base: null, pending: null }
  },
  onCreate() {
    const editor = this.editor
    const ext = this
    const md = editor.storage.markdown
    const parse = md.parser.parse.bind(md.parser)
    // setContent(字符串) 会走到这里：记下原文，等文档更新后再对应
    md.parser.parse = (content, opts = {}) => {
      if (typeof content === 'string' && !opts.inline) {
        // 只与同一次调用中紧接着的文档更新配对，避免把旧原文对应到别的内容上
        ext.storage.pending = content
        queueMicrotask(() => (ext.storage.pending = null))
      }
      return parse(content, opts)
    }
    const plain = md.getMarkdown
    md.getMarkdownPlain = plain
    md.getMarkdown = () => {
      const doc = editor.state.doc
      const out = serializeWithSource(ext.storage.base, doc, (node) =>
        md.serializer.serialize(doc.type.create(null, [node])),
      )
      return out ?? plain()
    }
  },
  onTransaction() {
    const s = this.storage
    if (s.pending === null) return
    const src = s.pending
    s.pending = null
    s.base = captureSource(this.editor.storage.markdown.parser.md, src, this.editor.state.doc)
  },
})
