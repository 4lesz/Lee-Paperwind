import { Editor, Extension, findChildren } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Strike from '@tiptap/extension-strike'
import Highlight from '@tiptap/extension-highlight'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import Image from '@tiptap/extension-image'
import BubbleMenu from '@tiptap/extension-bubble-menu'
import CodeBlock from '@tiptap/extension-code-block'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { createLowlight, common } from 'lowlight'
import { Markdown } from 'tiptap-markdown'
import markdownItMark from 'markdown-it-mark'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import HardBreak from '@tiptap/extension-hard-break'
import { HtmlBlock, HtmlInline, Kbd } from './html-preserve.js'
import { SourcePreserve } from './source-preserve.js'
import { FrontMatter } from './front-matter.js'
import { MermaidDiagram } from './diagram.js'
import { setDocDir, resolveImageSrc, isSafeHref } from './paths.js'

import powershell from 'highlight.js/lib/languages/powershell'

export const lowlight = createLowlight(common)
lowlight.register({ powershell })

// 代码高亮的缓存：Tiptap 的代码块插件在「光标在代码块里」时每次改动都会重新高亮整篇所有代码块，
// 1MB 文档里每按一次键要多花约 140ms。同样的「语言 + 代码」直接复用上次的结果。
// 键里只放语言和代码，代码变了自然换一条；超过 2000 条整体清空，避免一直涨。
const highlightCache = new Map()
const highlightCached = (language, code) => {
  const key = language + '\u0000' + code
  const hit = highlightCache.get(key)
  if (hit) return hit
  const out = lowlight.highlight(language, code)
  if (highlightCache.size > 2000) highlightCache.clear()
  highlightCache.set(key, out)
  return out
}

// 没标语言的代码块按纯文本显示，不自动猜测语言（避免「纯文本」却带颜色）
const lowlightNoAuto = {
  highlight: (language, code) => (language ? highlightCached(language, code) : lowlight.highlight('plaintext', code)),
  highlightAuto: (code) => highlightCached('plaintext', code),
  listLanguages: () => lowlight.listLanguages(),
  registered: (name) => lowlight.registered(name),
}

// 高亮：Markdown 中以 ==文字== 保存
const MarkdownHighlight = Highlight.extend({
  addStorage() {
    return {
      markdown: {
        serialize: { open: '==', close: '==', mixable: true, expelEnclosingWhitespace: true },
        parse: {
          setup(md) {
            md.use(markdownItMark)
          },
        },
      },
    }
  },
})

// 删除线快捷键改为 Ctrl+Shift+X（Ctrl+Shift+S 留给“另存为”）
const StrikeX = Strike.extend({
  addKeyboardShortcuts() {
    return { 'Mod-Shift-x': () => this.editor.commands.toggleStrike() }
  },
})

export { setDocDir, resolveImageSrc, isSafeHref }

// 代码块高亮：只重算真正变化的代码块。
// Tiptap 自带的实现只要光标在代码块里，每次按键都会把整篇所有代码块的装饰重建一遍，
// 1MB 文档里每键多花约 140ms；这里改成按节点对象判断，只更新变动的那一块。
const lowlightKey = new PluginKey('lowlight-cached')

const highlightNodes = (result) => result.value || result.children || []
const flattenNodes = (nodes, classes = []) =>
  nodes
    .map((n) => {
      const cls = [...classes, ...((n.properties && n.properties.className) || [])]
      if (n.children) return flattenNodes(n.children, cls)
      return { text: n.value, classes: cls }
    })
    .flat()

const codeDecorations = (blocks, lowlight, defaultLanguage) => {
  const decorations = []
  const known = (language) => {
    if (!language) return false
    const languages = lowlight.listLanguages()
    return languages.includes(language) || lowlight.registered(language)
  }
  for (const block of blocks) {
    let from = block.pos + 1
    const language = block.node.attrs.language || defaultLanguage
    // 没标语言或语言没注册（如 mermaid）时按纯文本处理，不自动猜语言
    const nodes = language && known(language) ? lowlight.highlight(language, block.node.textContent) : lowlight.highlightAuto(block.node.textContent)
    for (const n of flattenNodes(highlightNodes(nodes))) {
      const to = from + n.text.length
      if (n.classes.length) decorations.push(Decoration.inline(from, to, { class: n.classes.join(' ') }))
      from = to
    }
  }
  return decorations
}

const lowlightPlugin = (name, lowlight, defaultLanguage) => {
  const all = (doc, blocks) => DecorationSet.create(doc, codeDecorations(blocks, lowlight, defaultLanguage))
  const blocksOf = (doc) => findChildren(doc, (node) => node.type.name === name)
  return new Plugin({
    key: lowlightKey,
    state: {
      init: (_, { doc }) => all(doc, blocksOf(doc)),
      apply(tr, old, oldState, newState) {
        if (!tr.docChanged) return old
        // 位置随改动平移；没变的代码块直接沿用原来的装饰
        const mapped = old.map(tr.mapping, tr.doc)
        const oldBlocks = blocksOf(oldState.doc)
        const newBlocks = blocksOf(newState.doc)
        if (oldBlocks.length !== newBlocks.length) return all(tr.doc, newBlocks)
        const changed = []
        for (let i = 0; i < newBlocks.length; i++) if (newBlocks[i].node !== oldBlocks[i].node) changed.push(i)
        if (!changed.length) return mapped
        if (changed.length > 8) return all(tr.doc, newBlocks) // 大面积变化（粘贴、整篇替换）直接重算
        let set = mapped
        for (const i of changed) {
          const b = newBlocks[i]
          const from = b.pos + 1
          const to = b.pos + b.node.nodeSize - 1
          set = set.remove(set.find(from, to))
          set = set.add(tr.doc, codeDecorations([b], lowlight, defaultLanguage))
        }
        return set
      },
    },
    props: {
      decorations(state) {
        return lowlightKey.getState(state)
      },
    },
  })
}

// 代码块：在 <pre> 上标注语言，用于右上角显示语言名（设计规范 §5）
const LabeledCodeBlock = CodeBlock.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      lowlight: {},
      languageClassPrefix: 'language-',
      defaultLanguage: null,
      HTMLAttributes: {},
    }
  },
  renderHTML({ node, HTMLAttributes }) {
    const lang = node.attrs.language
    return [
      'pre',
      { ...this.options.HTMLAttributes, ...HTMLAttributes, 'data-language': lang || '' },
      ['code', { class: lang ? this.options.languageClassPrefix + lang : null }, 0],
    ]
  },
  addProseMirrorPlugins() {
    return [...(this.parent?.() || []), lowlightPlugin(this.name, this.options.lowlight, this.options.defaultLanguage)]
  },
})

// 额外快捷键：清除格式 Ctrl+Shift+0
const ExtraShortcuts = Extension.create({
  name: 'extraShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-0': () => this.editor.chain().focus().unsetAllMarks().clearNodes().run(),
    }
  },
})

// 清单也使用紧凑列表（tiptap-markdown 默认只处理无序/有序列表），保证清单项之间不插入空行
const TaskListTight = Extension.create({
  name: 'taskListTight',
  addGlobalAttributes() {
    return [
      {
        types: ['taskList'],
        attributes: {
          tight: {
            default: true,
            parseHTML: (el) => el.getAttribute('data-tight') === 'true' || !el.querySelector('p'),
            renderHTML: (attrs) => ({ 'data-tight': attrs.tight ? 'true' : null }),
          },
        },
      },
    ]
  },
})

// 链接、图片地址写回 Markdown：含空格等字符时用 <地址>，否则转义括号
const mdDest = (url) => (/[\s<>]/.test(url) ? `<${url}>` : url.replace(/[()]/g, '\\$&'))
const mdTitle = (t) => (t ? ` "${t.replace(/"/g, '\\"')}"` : '')

// 图片：行内元素（设计规范 §5），可以和文字、其他图片同处一段，也可以带链接（徽章）
const LocalImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    return ['img', { ...HTMLAttributes, src: resolveImageSrc(HTMLAttributes.src) }]
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const alt = (node.attrs.alt || '').replace(/[[\]\\]/g, '\\$&')
          state.write(`![${alt}](${mdDest(node.attrs.src || '')}${mdTitle(node.attrs.title)})`)
        },
        parse: {},
      },
    }
  },
})

// 链接：记住原来的写法（裸网址 / <网址> / [文字](地址)），保存时照原样写
function linkText(parent, index, mark) {
  let text = ''
  for (let i = index; i < parent.childCount; i++) {
    const c = parent.child(i)
    if (!mark.isInSet(c.marks)) break
    if (!c.isText) return null
    text += c.text
  }
  return text
}
const MdLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mdStyle: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-md'),
        renderHTML: () => ({}),
      },
    }
  },
  addStorage() {
    return {
      markdown: {
        serialize: {
          open(state, mark, parent, index) {
            const text = linkText(parent, index, mark)
            const href = mark.attrs.href || ''
            const plain = text !== null && !mark.attrs.title && !/\s/.test(text)
            if (plain && mark.attrs.mdStyle === 'linkify' && (href === text || href.endsWith('//' + text) || href === 'mailto:' + text)) {
              state.inAutolink = 'bare'
              return ''
            }
            if (plain && (mark.attrs.mdStyle === 'autolink' || (text === href && /^[a-z][a-z0-9+.-]*:/i.test(href)))) {
              state.inAutolink = 'angle'
              return '<'
            }
            state.inAutolink = undefined
            return '['
          },
          close(state, mark) {
            const style = state.inAutolink
            state.inAutolink = undefined
            if (style === 'bare') return ''
            if (style === 'angle') return '>'
            return `](${mdDest(mark.attrs.href || '')}${mdTitle(mark.attrs.title)})`
          },
          mixable: true,
        },
        parse: {},
      },
    }
  },
})

// 例外：换行两边的行都只有图片（GitHub README 里一行一个的徽章）时，仍排在同一行（设计规范 §5「单个换行」，AC-G03）
const PICTURE_PARTS = new Set(['image', 'link_open', 'link_close'])
function picturesOnly(tokens, idx, dir) {
  let pics = 0
  for (let i = idx + dir; i >= 0 && i < tokens.length; i += dir) {
    const t = tokens[i]
    if (t.type === 'softbreak' || t.type === 'hardbreak') break
    if (t.type === 'image' || (t.type === 'html_inline' && /^<img\b/i.test(t.content))) pics++
    else if (!(PICTURE_PARTS.has(t.type) || (t.type === 'text' && !t.content.trim()))) return false
  }
  return pics > 0
}

// 换行：文件里写的是 <br> 时，保存时仍写 <br>（AC-M05）
// 段落里的单个换行（软换行）也显示为换行，保存时仍写为单个换行（设计规范 §5「单个换行」，AC-W01、W02）
const HtmlBreak = HardBreak.extend({
  addAttributes() {
    return {
      html: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-html'),
        renderHTML: () => ({}),
      },
      soft: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-soft') === 'true',
        renderHTML: (attrs) => (attrs.soft ? { 'data-soft': 'true' } : {}),
      },
    }
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node, parent, index) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              state.write(node.attrs.html || (node.attrs.soft && !state.inTable ? '\n' : state.inTable ? '<br>' : '\\\n'))
              return
            }
          }
          if (node.attrs.html) state.write(node.attrs.html)
        },
        parse: {
          setup(md) {
            md.renderer.rules.softbreak = (tokens, idx) =>
              picturesOnly(tokens, idx, -1) && picturesOnly(tokens, idx, 1) ? '\n' : '<br data-soft="true">\n'
          },
        },
      },
    }
  },
})

export function createEditor({ element, bubbleElement, onUpdate, onSelection, onLinkClick }) {
  // 徽章、图标等小图（高 ≤ 32px）不加圆角（设计规范 §5）
  element.addEventListener(
    'load',
    (e) => {
      if (e.target.tagName === 'IMG') e.target.classList.toggle('small', e.target.height <= 32)
    },
    true,
  )
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ codeBlock: false, strike: false, hardBreak: false }),
      HtmlBreak,
      StrikeX,
      MarkdownHighlight,
      Underline,
      MdLink.configure({ openOnClick: false, autolink: true, linkOnPaste: true, isAllowedUri: (url) => isSafeHref(url) }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      LocalImage.configure({ inline: true, allowBase64: true }),
      LabeledCodeBlock.configure({ lowlight: lowlightNoAuto, defaultLanguage: null }),
      ExtraShortcuts,
      TaskListTight,
      Subscript,
      Superscript,
      Kbd,
      FrontMatter,
      HtmlBlock,
      HtmlInline,
      SourcePreserve,
      MermaidDiagram,
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === 'heading' ? '标题' : '开始输入…'),
      }),
      BubbleMenu.configure({
        element: bubbleElement,
        tippyOptions: { duration: [250, 120], placement: 'top', offset: [0, 8], maxWidth: 'none', animation: 'bubble' },
        shouldShow: ({ editor, state, from, to }) => {
          if (!editor.isEditable || from === to) return false
          if (editor.isActive('codeBlock') || editor.isActive('image')) return false
          return state.doc.textBetween(from, to).trim().length > 0
        },
      }),
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: '-',
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: false,
      }),
    ],
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'false' },
      // 自动滚动时让光标避开顶部的格式栏和底部的上一篇 / 下一篇卡片（§4.2、§4.13）
      scrollMargin: { top: 80, bottom: 116, left: 5, right: 5 },
      scrollThreshold: { top: 80, bottom: 116, left: 5, right: 5 },
      handleClick(view, pos, event) {
        // Ctrl+单击链接：在浏览器中打开
        const a = event.target.closest?.('a[href]')
        if (a && (event.ctrlKey || event.metaKey || !view.editable)) {
          event.preventDefault()
          onLinkClick?.(a.getAttribute('href'))
          return true
        }
        return false
      },
      handleDOMEvents: {
        // 阻止链接的默认跳转（否则阅读模式下会再触发一次外部打开）
        click(_view, event) {
          if (event.target.closest?.('a[href]')) event.preventDefault()
          return false
        },
      },
    },
    onUpdate,
    onSelectionUpdate: onSelection,
    onTransaction: onSelection,
  })
}

export const CODE_LANGUAGES = [
  ['', '纯文本'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['python', 'Python'],
  ['java', 'Java'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['php', 'PHP'],
  ['ruby', 'Ruby'],
  ['kotlin', 'Kotlin'],
  ['swift', 'Swift'],
  ['bash', 'Bash'],
  ['powershell', 'PowerShell'],
  ['sql', 'SQL'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['xml', 'HTML/XML'],
  ['css', 'CSS'],
  ['markdown', 'Markdown'],
  ['diff', 'Diff'],
]
