// Markdown 文件中的 HTML（设计规范 §5.1，AC-M05、AC-G01–G07）
//
// 原则：看起来和 GitHub 上一样；文件里的 HTML 一个字都不改；任何脚本都不执行。
// - 块级 HTML：完整的块按白名单过滤后直接渲染；单独的开始 / 结束标签、注释在编辑模式下是小标签，
//   阅读模式下隐藏；<div align> 之间的内容按 align 对齐；<details> 在阅读模式可折叠。
// - 行内 HTML：自成一体的（如 <img>）直接渲染；成对标签的开始 / 结束部分是小标签。
// - <sub> <sup> <kbd> <u> 等 → 作为格式显示；<br> → 换行，保存时仍写 <br>。
// 保存时一律写回原始 HTML 文本（node.attrs.html）。
import { Node, Mark, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { resolveImageSrc, isSafeHref } from './paths.js'

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 这些行内标签由编辑器自身的格式处理，交给默认流程
const KNOWN_INLINE = /^<\/?(u|ins|sub|sup|kbd|mark|b|strong|i|em|s|del|strike|code|input)(\s[^>]*)?\/?>$/i

// ---------------- 白名单过滤 ----------------
const ALLOWED_TAGS = new Set(
  (
    'div p span a img table thead tbody tfoot tr th td caption colgroup col br hr b strong i em u s del ins ' +
    'sub sup kbd code pre samp var blockquote q cite ul ol li dl dt dd h1 h2 h3 h4 h5 h6 details summary ' +
    'picture center small big mark abbr figure figcaption section article header footer nav aside main ' +
    'font tt strike'
  ).split(' '),
)
// 连同内容一起去掉
const DROP_TAGS = new Set(
  'script style iframe frame frameset object embed applet form input button textarea select option link meta base svg math template noscript audio video source track canvas title head'.split(
    ' ',
  ),
)
const ALLOWED_ATTRS = new Set(
  'align valign href src alt title width height colspan rowspan scope open name id dir lang start reversed type border cellpadding cellspacing nowrap headers abbr datetime cite color size'.split(
    ' ',
  ),
)

function cleanNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8) {
      child.remove() // 注释
      continue
    }
    if (child.nodeType !== 1) continue
    const tag = child.tagName.toLowerCase()
    if (DROP_TAGS.has(tag)) {
      child.remove()
      continue
    }
    cleanNode(child)
    if (!ALLOWED_TAGS.has(tag)) {
      child.replaceWith(...child.childNodes) // 不认识的标签：去掉标签、保留内容
      continue
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase()
      if (!ALLOWED_ATTRS.has(name)) child.removeAttribute(attr.name)
      else if (name === 'href' && !isSafeHref(attr.value)) child.removeAttribute(attr.name)
    }
    if (tag === 'img') {
      const src = child.getAttribute('src')
      const resolved = src ? resolveImageSrc(src) : ''
      if (resolved) child.setAttribute('src', resolved)
      else child.removeAttribute('src')
      child.setAttribute('draggable', 'false')
    }
    if (tag === 'a') child.setAttribute('draggable', 'false')
  }
}

// 先在文本层面去掉 on… 事件属性：浏览器解析到它们时即使不执行也会在控制台报告安全策略拦截
const stripHandlers = (html) => html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')

// 返回过滤后的 DocumentFragment（解析在惰性模板中进行：脚本不执行、图片不加载）
export function sanitizeHtml(html) {
  const t = document.createElement('template')
  t.innerHTML = stripHandlers(html)
  cleanNode(t.content)
  return document.importNode(t.content, true)
}

const hasVisible = (frag) =>
  frag.textContent.trim() !== '' || !!frag.querySelector?.('img,hr,table,br')

// ---------------- 分类 ----------------
const TAG_OPEN = /^\s*<([a-zA-Z][\w-]*)([^>]*)>/
const CLOSE_ONLY = /^\s*(<\/[a-zA-Z][\w-]*\s*>\s*)+$/
const COMMENT_ONLY = /^\s*<!--[\s\S]*?-->\s*$/

const countTag = (html, tag) => {
  const open = (html.match(new RegExp(`<${tag}(?=[\\s>/])`, 'gi')) || []).length
  const close = (html.match(new RegExp(`</${tag}\\s*>`, 'gi')) || []).length
  return { open, close }
}

// kind: 'comment' | 'close' | 'open' | 'render'
export function classifyBlock(html) {
  if (COMMENT_ONLY.test(html)) return { kind: 'comment' }
  if (CLOSE_ONLY.test(html)) {
    const tags = [...html.matchAll(/<\/([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase())
    return { kind: 'close', tags }
  }
  const m = TAG_OPEN.exec(html)
  if (m) {
    const tag = m[1].toLowerCase()
    const { open, close } = countTag(html, tag)
    if (open > close) {
      const attrs = m[2]
      const align = /\balign\s*=\s*["']?(center|right|left)/i.exec(attrs)?.[1]?.toLowerCase() || null
      const info = { kind: 'open', tag, align, openTag: m[0].trim() }
      if (tag === 'details') {
        info.summary = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(html)?.[1] ?? null
        info.startOpen = /\bopen\b/i.test(attrs)
      }
      return info
    }
  }
  return { kind: 'render' }
}

// ---------------- markdown-it ----------------
function setupRenderer(md) {
  if (md.__htmlPreserve) return
  md.__htmlPreserve = true
  // 链接地址保持原文，不做百分号编码（否则保存时中文路径会变成 %E7%AC%AC…）
  md.normalizeLink = (url) => url
  md.renderer.rules.html_block = (tokens, idx) =>
    `<div data-type="html-block" data-html="${escapeAttr(tokens[idx].content)}"></div>\n`
  md.renderer.rules.html_inline = (tokens, idx, _opts, env) => {
    const c = tokens[idx].content
    const t = c.trim()
    const stack = (env.__aStack ||= [])
    if (/^<br\s*\/?>$/i.test(t)) return `<br data-html="${escapeAttr(c)}">`
    if (/^<a\s/i.test(t) && /\bhref\s*=/i.test(t)) {
      stack.push('link')
      return stripHandlers(c) // 交给编辑器转成链接（只取 href）；未改动的段落保存时由原文保留写回原样
    }
    if (/^<a[\s>]/i.test(t)) stack.push('raw')
    if (/^<\/a\s*>$/i.test(t) && stack.pop() === 'link') return c
    if (KNOWN_INLINE.test(t)) return stripHandlers(c)
    return `<span data-type="html-inline" data-html="${escapeAttr(c)}"></span>`
  }
  // 记住链接原来的写法：裸网址（linkify）或 <网址>（autolink），保存时照原样写
  const linkOpen = md.renderer.rules.link_open
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx]
    if (t.markup === 'linkify' || t.markup === 'autolink') t.attrSet('data-md', t.markup)
    return linkOpen ? linkOpen(tokens, idx, opts, env, self) : self.renderToken(tokens, idx, opts)
  }
}

// ---------------- 块级 HTML ----------------
const chip = (text) => {
  const el = document.createElement('span')
  el.className = 'html-chip'
  el.textContent = text.replace(/\s+/g, ' ').trim()
  return el
}

export const detailsKey = new PluginKey('htmlRanges')

// 行内 HTML 中自成一体、可以直接渲染的元素
const SELF_CONTAINED = /^<(img|hr|wbr)\b[^>]*>$/i

// 段落里只有标签（成对标签的开始 / 结束、注释）和空白
function isTagsOnly(node) {
  let only = true
  node.forEach((c) => {
    if (c.type.name === 'htmlInline' && !SELF_CONTAINED.test(c.attrs.html.trim())) return
    if (c.isText && !c.text.trim()) return
    only = false
  })
  return only
}

export const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-html') || '',
        renderHTML: (attrs) => ({ 'data-html': attrs.html }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="html-block"]' }]
  },
  // 复制到剪贴板时的形式：原始 HTML 文本
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'html-block', class: 'html-block' }),
      ['code', {}, node.attrs.html.replace(/\n+$/, '')],
    ]
  },
  addNodeView() {
    return ({ node: initial, editor, getPos }) => {
      let node = initial
      const dom = document.createElement('div')
      dom.className = 'html-block'
      dom.contentEditable = 'false'
      const render = () => {
        const html = node.attrs.html.replace(/\n+$/, '')
        const info = classifyBlock(html)
        dom.replaceChildren()
        let kind = info.kind
        if (kind === 'open' && info.tag === 'details') {
          kind = 'details'
          const row = document.createElement('div')
          row.className = 'html-summary'
          row.innerHTML = '<svg class="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          const sum = document.createElement('span')
          sum.className = 'sum'
          sum.append(info.summary != null ? sanitizeHtml(info.summary) : '详细信息')
          row.append(sum)
          row.addEventListener('click', (e) => {
            if (editor.isEditable) return
            e.preventDefault()
            const pos = getPos()
            if (typeof pos === 'number') editor.view.dispatch(editor.state.tr.setMeta(detailsKey, { toggle: pos }))
          })
          dom.append(row)
        } else if (kind === 'render' || kind === 'open') {
          const frag = sanitizeHtml(html)
          if (hasVisible(frag)) {
            kind = 'render'
            const box = document.createElement('div')
            box.className = 'html-render'
            box.append(frag)
            const tag = document.createElement('span')
            tag.className = 'html-label'
            tag.textContent = 'HTML'
            tag.dataset.tip = 'HTML（在源码模式中编辑）'
            dom.append(box, tag)
          } else {
            kind = 'chip'
            dom.append(chip(info.openTag || html))
          }
        } else {
          kind = 'chip' // 结束标签、注释
          dom.append(chip(html))
        }
        dom.dataset.kind = kind
      }
      render()
      return {
        dom,
        update(n) {
          if (n.type !== node.type) return false
          if (n.attrs.html !== node.attrs.html) {
            node = n
            render()
          }
          node = n
          return true
        },
        ignoreMutation: () => true,
      }
    }
  },
  addProseMirrorPlugins() {
    const editor = this.editor
    // 对齐与折叠：在顶层扫描开始 / 结束标签，给中间的内容加样式
    return [
      new Plugin({
        key: detailsKey,
        state: {
          init: () => ({ flipped: new Set() }),
          apply(tr, value) {
            let flipped = value.flipped
            if (tr.docChanged) {
              const next = new Set()
              flipped.forEach((p) => {
                const r = tr.mapping.mapResult(p)
                if (!r.deleted) next.add(r.pos)
              })
              flipped = next
            }
            const meta = tr.getMeta(detailsKey)
            if (meta?.toggle != null) {
              flipped = new Set(flipped)
              if (flipped.has(meta.toggle)) flipped.delete(meta.toggle)
              else flipped.add(meta.toggle)
            }
            return flipped === value.flipped ? value : { flipped }
          },
        },
        props: {
          decorations(state) {
            const { flipped } = detailsKey.getState(state)
            const decos = []
            const stack = []
            state.doc.forEach((node, pos) => {
              let info = null
              if (node.type.name === 'htmlBlock') info = classifyBlock(node.attrs.html)
              if (info?.kind === 'close') {
                for (const tag of info.tags) {
                  const i = stack.map((f) => f.tag).lastIndexOf(tag)
                  if (i >= 0) stack.splice(i)
                }
              }
              const classes = []
              if (node.isTextblock && node.childCount && isTagsOnly(node)) classes.push('html-only')
              const align = [...stack].reverse().find((f) => f.align)?.align
              if (align) classes.push('md-align-' + align)
              if (stack.some((f) => f.tag === 'details' && !f.expanded)) classes.push('html-collapsed')
              const attrs = classes.length ? { class: classes.join(' ') } : {}
              if (info?.kind === 'open') {
                const frame = { tag: info.tag, align: info.align }
                if (info.tag === 'details') {
                  frame.expanded = !!info.startOpen !== flipped.has(pos)
                  attrs['data-open'] = frame.expanded ? 'true' : 'false'
                }
                stack.push(frame)
              }
              if (Object.keys(attrs).length) decos.push(Decoration.node(pos, pos + node.nodeSize, attrs))
            })
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(node.attrs.html.replace(/\n+$/, ''))
          state.closeBlock(node)
        },
        parse: { setup: setupRenderer },
      },
    }
  },
})

// ---------------- 行内 HTML ----------------
// 自成一体的元素（如 <img>）直接渲染；开始 / 结束标签、注释显示为小标签

export const HtmlInline = Node.create({
  name: 'htmlInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-html') || '',
        renderHTML: (attrs) => ({ 'data-html': attrs.html }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-type="html-inline"]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'html-inline', class: 'html-inline' }), node.attrs.html]
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span')
      dom.contentEditable = 'false'
      const html = node.attrs.html.trim()
      if (SELF_CONTAINED.test(html)) {
        dom.className = 'html-inline rendered'
        dom.append(sanitizeHtml(html))
      } else {
        dom.className = 'html-inline'
        dom.textContent = node.attrs.html
      }
      return { dom, ignoreMutation: () => true }
    }
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(node.attrs.html)
        },
        parse: { setup: setupRenderer },
      },
    }
  },
})

// 键盘按键 <kbd>
export const Kbd = Mark.create({
  name: 'kbd',
  parseHTML() {
    return [{ tag: 'kbd' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['kbd', HTMLAttributes, 0]
  },
})
