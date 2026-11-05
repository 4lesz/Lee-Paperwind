// 格式栏与浮动菜单（设计规范 §4.2、§4.4）
import { icons } from './icons.js'
import { openPopover, closePopover } from './ui.js'

export function formatButtons(ctx) {
  return {
    bold: { icon: 'bold', tip: '粗体', key: 'Ctrl+B', run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
    italic: { icon: 'italic', tip: '斜体', key: 'Ctrl+I', run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
    underline: { icon: 'underline', tip: '下划线', key: 'Ctrl+U', run: (e) => e.chain().focus().toggleUnderline().run(), active: (e) => e.isActive('underline') },
    strike: { icon: 'strike', tip: '删除线', key: 'Ctrl+Shift+X', run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive('strike') },
    highlight: { icon: 'highlight', tip: '高亮', key: 'Ctrl+Shift+H', run: (e) => e.chain().focus().toggleHighlight().run(), active: (e) => e.isActive('highlight') },
    taskList: { icon: 'taskList', tip: '清单', key: 'Ctrl+Shift+9', run: (e) => e.chain().focus().toggleTaskList().run(), active: (e) => e.isActive('taskList') },
    bulletList: { icon: 'bulletList', tip: '无序列表', key: 'Ctrl+Shift+8', run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
    orderedList: { icon: 'orderedList', tip: '有序列表', key: 'Ctrl+Shift+7', run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
    quote: { icon: 'quote', tip: '引用', key: 'Ctrl+Shift+B', run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive('blockquote') },
    code: { icon: 'code', tip: '行内代码', key: 'Ctrl+E', run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive('code') },
    codeBlock: { icon: 'codeBlock', tip: '代码块', key: 'Ctrl+Alt+C', run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (e) => e.isActive('codeBlock') },
    table: { icon: 'table', tip: '表格', run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), active: (e) => e.isActive('table') },
    image: { icon: 'image', tip: '图片', run: () => ctx.insertImage() },
    link: { icon: 'link', tip: '链接', key: 'Ctrl+K', run: () => ctx.editLink(), active: (e) => e.isActive('link') },
    hr: { icon: 'hr', tip: '分割线', run: (e) => e.chain().focus().setHorizontalRule().run() },
  }
}

const TOOLBAR_LAYOUT = [
  ['@style'],
  ['bold', 'italic', 'underline', 'strike', 'highlight'],
  ['taskList', 'bulletList', 'orderedList'],
  ['quote', 'code', 'codeBlock', 'table', 'image', 'link', 'hr'],
  ['@context'],
]
const BUBBLE_LAYOUT = ['bold', 'italic', 'underline', 'strike', 'highlight', 'code', 'link']

// 「Aa」段落样式（同苹果备忘录）
const BLOCK_STYLES = [
  { id: 'h1', label: '标题', cls: 'pv-h1', run: (c) => c.setHeading({ level: 1 }), is: (e) => e.isActive('heading', { level: 1 }) },
  { id: 'h2', label: '小标题', cls: 'pv-h2', run: (c) => c.setHeading({ level: 2 }), is: (e) => e.isActive('heading', { level: 2 }) },
  { id: 'h3', label: '副标题', cls: 'pv-h3', run: (c) => c.setHeading({ level: 3 }), is: (e) => e.isActive('heading', { level: 3 }) },
  { id: 'p', label: '正文', cls: 'pv-p', run: (c) => c.setParagraph(), is: (e) => e.isActive('paragraph') && !e.isActive('codeBlock') },
  { id: 'mono', label: '等宽', cls: 'pv-mono', run: (c) => c.setCodeBlock(), is: (e) => e.isActive('codeBlock') },
]

function makeButton(id, def) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'fmt-btn'
  b.dataset.cmd = id
  b.dataset.tip = def.tip
  if (def.key) b.dataset.key = def.key
  b.setAttribute('aria-label', def.tip)
  b.innerHTML = icons[def.icon]
  b.addEventListener('mousedown', (ev) => ev.preventDefault()) // 保持编辑器选区
  return b
}

function makePill(label, tip) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'fmt-btn pill'
  if (tip) b.dataset.tip = tip
  b.innerHTML = `<span class="pill-label">${label}</span>${icons.chevron}`
  b.addEventListener('mousedown', (ev) => ev.preventDefault())
  return b
}

export function buildToolbar({ toolbarEl, bubbleEl, getEditor, ctx, languages }) {
  const defs = formatButtons(ctx)
  const buttons = []
  let contextGroup

  // 「Aa」按钮
  const styleBtn = document.createElement('button')
  styleBtn.type = 'button'
  styleBtn.className = 'fmt-btn aa'
  styleBtn.dataset.cmd = 'style'
  styleBtn.dataset.tip = '段落样式'
  styleBtn.dataset.key = 'Ctrl+Alt+0~3'
  styleBtn.textContent = 'Aa'
  styleBtn.addEventListener('mousedown', (ev) => ev.preventDefault())
  styleBtn.addEventListener('click', () => {
    const e = getEditor()
    openPopover(
      styleBtn,
      BLOCK_STYLES.map((s) => ({
        html: `<span class="${s.cls}">${s.label}</span>`,
        checked: s.is(e),
        run: () => s.run(e.chain().focus()).run(),
      })),
      { className: 'styles' }
    )
  })

  for (const group of TOOLBAR_LAYOUT) {
    const g = document.createElement('div')
    g.className = 'fmt-group'
    for (const id of group) {
      if (id === '@style') g.appendChild(styleBtn)
      else if (id === '@context') {
        g.classList.add('context')
        contextGroup = g
      } else {
        const b = makeButton(id, defs[id])
        b.addEventListener('click', () => defs[id].run(getEditor()))
        g.appendChild(b)
        buttons.push([b, defs[id]])
      }
    }
    toolbarEl.appendChild(g)
  }

  for (const id of BUBBLE_LAYOUT) {
    const b = makeButton(id, defs[id])
    b.addEventListener('click', () => defs[id].run(getEditor()))
    bubbleEl.appendChild(b)
    buttons.push([b, defs[id]])
  }

  // 上下文：代码语言
  const langNames = new Map(languages)
  const langBtn = makePill('纯文本', '代码语言')
  langBtn.addEventListener('click', () => {
    const e = getEditor()
    const cur = e.getAttributes('codeBlock').language || ''
    const list = [...languages]
    if (cur && !langNames.has(cur)) list.push([cur, cur])
    openPopover(
      langBtn,
      list.map(([v, t]) => ({
        label: t,
        checked: v === cur,
        run: () => e.chain().focus().updateAttributes('codeBlock', { language: v || null }).run(),
      })),
      { className: 'langs' }
    )
  })

  // 上下文：表格
  const tableBtn = makePill('表格', '表格操作')
  tableBtn.addEventListener('click', () => {
    const c = () => getEditor().chain().focus()
    openPopover(tableBtn, [
      { label: '在下方插入行', run: () => c().addRowAfter().run() },
      { label: '在上方插入行', run: () => c().addRowBefore().run() },
      { label: '在右侧插入列', run: () => c().addColumnAfter().run() },
      { label: '在左侧插入列', run: () => c().addColumnBefore().run() },
      { separator: true },
      { label: '删除行', run: () => c().deleteRow().run() },
      { label: '删除列', run: () => c().deleteColumn().run() },
      { label: '删除表格', danger: true, run: () => c().deleteTable().run() },
    ])
  })

  let lastContext = null
  function refresh() {
    const e = getEditor()
    if (!e) return
    for (const [b, def] of buttons) {
      if (def.active) {
        const on = !!def.active(e)
        b.classList.toggle('active', on)
        b.setAttribute('aria-pressed', on)
      }
    }
    const inCode = e.isActive('codeBlock')
    styleBtn.classList.toggle('active', BLOCK_STYLES.slice(0, 3).some((s) => s.is(e)) || inCode)

    const ctxType = inCode ? 'code' : e.isActive('table') ? 'table' : null
    if (ctxType === 'code') {
      const lang = e.getAttributes('codeBlock').language || ''
      langBtn.querySelector('.pill-label').textContent = langNames.get(lang) || lang || '纯文本'
    }
    if (ctxType !== lastContext) {
      if (lastContext) closePopover()
      contextGroup.replaceChildren(...(ctxType === 'code' ? [langBtn] : ctxType === 'table' ? [tableBtn] : []))
      lastContext = ctxType
    }
  }
  return { refresh }
}
