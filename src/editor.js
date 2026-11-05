import { Editor, Extension } from '@tiptap/core'
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
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import { Markdown } from 'tiptap-markdown'
import markdownItMark from 'markdown-it-mark'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import HardBreak from '@tiptap/extension-hard-break'
import { HtmlBlock, HtmlInline, Kbd } from './html-preserve.js'
import { SourcePreserve } from './source-preserve.js'
import { FrontMatter } from './front-matter.js'
import { setDocDir, resolveImageSrc, isSafeHref } from './paths.js'

import powershell from 'highlight.js/lib/languages/powershell'

export const lowlight = createLowlight(common)
lowlight.register({ powershell })

// 没标语言的代码块按纯文本显示，不自动猜测语言（避免「纯文本」却带颜色）
const lowlightNoAuto = {
  highlight: (...a) => lowlight.highlight(...a),
  highlightAuto: (code) => lowlight.highlight('plaintext', code),
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

// 代码块：在 <pre> 上标注语言，用于右上角显示语言名（设计规范 §5）
const LabeledCodeBlock = CodeBlockLowlight.extend({
  renderHTML({ node, HTMLAttributes }) {
    const lang = node.attrs.language
    return [
      'pre',
      { ...this.options.HTMLAttributes, ...HTMLAttributes, 'data-language': lang || '' },
      ['code', { class: lang ? this.options.languageClassPrefix + lang : null }, 0],
    ]
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

// 换行：文件里写的是 <br> 时，保存时仍写 <br>（AC-M05）
const HtmlBreak = HardBreak.extend({
  addAttributes() {
    return {
      html: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-html'),
        renderHTML: () => ({}),
      },
    }
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node, parent, index) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              state.write(node.attrs.html || (state.inTable ? '<br>' : '\\\n'))
              return
            }
          }
          if (node.attrs.html) state.write(node.attrs.html)
        },
        parse: {},
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
