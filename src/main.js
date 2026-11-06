import './style.css'
import { icons } from './icons.js'
import { createEditor, setDocDir, CODE_LANGUAGES } from './editor.js'
import { buildToolbar } from './toolbar.js'
import { toast, askFields, askChoice, pickItem, createSegmented, setTipResolver } from './ui.js'
import { createFolderNav, sameFile, isWithin, splitName } from './folder.js'
import { parseIndex, setIndexInRaw, setIndexInText, splitFrontMatter, FM_META } from './front-matter.js'
import { findHeading, scrollToPos, capturePosition, restorePosition } from './position.js'
import { Selection } from '@tiptap/pm/state'
import { createPageTurn } from './page-turn.js'
import { createLinkBurst } from './link-burst.js'

const api = window.api
const $ = (id) => document.getElementById(id)

const state = {
  path: null,
  name: '未命名.md',
  savedMd: '',
  dirty: false,
  mode: 'edit', // edit | source | read
  index: {}, // 翻页索引（属性区里的 prev / next，已解析成文件路径，§4.13b）
}

const sourceEl = $('source')
const paperEl = $('paper')

// ---------------- 小工具 ----------------
function debounce(fn, ms) {
  let t
  return (...a) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}
const dirOf = (p) => (p ? p.replace(/[\\/][^\\/]*$/, '') : null)

// ---------------- 编辑器 ----------------
const ctx = {
  async editLink() {
    const { from, to, empty } = editor.state.selection
    const current = editor.getAttributes('link').href || ''
    const fields = [{ label: '链接地址', placeholder: 'https://…', value: current }]
    if (empty && !current) fields.push({ label: '显示文字', placeholder: '可选' })
    const r = await askFields({ title: current ? '编辑链接' : '添加链接', fields })
    if (r === null) return editor.commands.focus()
    const [href, text] = r
    const chain = editor.chain().focus()
    if (!href) return chain.extendMarkRange('link').unsetLink().run()
    if (empty && !current) {
      const label = text || href
      chain
        .insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] })
        .run()
    } else {
      chain.setTextSelection({ from, to }).extendMarkRange('link').setLink({ href }).run()
    }
  },
  async insertImage() {
    const r = await askFields({
      title: '插入图片',
      fields: [
        { label: '图片地址或本地路径', placeholder: 'https://… 或点「选择图片…」' },
        { label: '描述文字（可选）', placeholder: '' },
      ],
      extraButton: {
        label: '选择图片…',
        target: 0,
        run: async () => {
          const p = await api.pickImage()
          if (!p) return null
          // 与文档同目录或子目录时，使用相对路径
          const dir = dirOf(state.path)
          if (dir && p.toLowerCase().startsWith(dir.toLowerCase() + '\\')) {
            return p.slice(dir.length + 1).replace(/\\/g, '/')
          }
          return p
        },
      },
    })
    if (!r || !r[0]) return editor.commands.focus()
    const src = /^[a-zA-Z]:\\/.test(r[0]) ? r[0].replace(/\\/g, '/') : r[0]
    // 图片是行内元素：插在光标处；选中的是图片等整块内容时，插在它后面而不是替换它
    const sel = editor.state.selection
    const at = sel.node ? sel.to : { from: sel.from, to: sel.to }
    const img = { type: 'image', attrs: { src, alt: r[1] || '' } } // 地址保持原文（含空格时保存为 <地址>）
    const parent = sel.$from.parent
    // 光标在空段落、标题等非正文段落中：图片单独成段，后面留一个空段落方便继续输入
    const ownBlock = sel.node ? !sel.node.isInline : parent.type.name !== 'paragraph' || parent.content.size === 0
    editor
      .chain()
      .focus()
      .insertContentAt(at, ownBlock ? [{ type: 'paragraph', content: [img] }, { type: 'paragraph' }] : img)
      .run()
  },
}

// 浮动菜单元素会被编辑器移出文档，需提前取到引用
const bubbleEl = $('bubble')
let toolbar = null
const editor = createEditor({
  element: $('editor'),
  bubbleElement: bubbleEl,
  onUpdate: () => {
    markDirty()
    afterChange()
    refreshIndex()
  },
  onSelection: () => toolbar?.refresh(),
  onLinkClick: (href) => handleLink(href),
})
window.__editor = editor // 方便调试

toolbar = buildToolbar({
  toolbarEl: $('toolbar'),
  bubbleEl,
  getEditor: () => editor,
  ctx,
  languages: CODE_LANGUAGES,
})
toolbar.refresh()

// 标题栏按钮
const modeSwitch = createSegmented({
  options: [
    { value: 'edit', label: '编辑' },
    { value: 'read', label: '阅读' },
  ],
  value: 'edit',
  tip: '切换编辑 / 阅读',
  key: 'Ctrl+R',
  label: '编辑或阅读',
  onChange: (v) => applyMode(v),
})
modeSwitch.el.classList.add('mode-switch')
$('modeSlot').replaceWith(modeSwitch.el)

document.querySelectorAll('.titlebar [data-cmd]').forEach((b) => {
  const cmd = b.dataset.cmd
  b.innerHTML = icons[cmd === 'theme' ? 'moon' : cmd]
  b.setAttribute('aria-label', b.dataset.tip)
  b.addEventListener('click', () => runCommand(cmd))
})
const btn = (cmd) => document.querySelector(`.titlebar [data-cmd=${cmd}]`)
// 「打开」按钮右键：打开文件… / 打开文件夹…
btn('open').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  api.openButtonMenu()
})
if (api.mica) document.documentElement.classList.add('mica')
document.querySelector('.drop-icon').innerHTML = icons.file

// ---------------- 文档状态 ----------------
function currentMarkdown() {
  return state.mode === 'source' ? sourceText() : editor.storage.markdown.getMarkdown()
}
// 源码框（textarea）会把 Windows 换行 \r\n 统一成 \n；取出时按文件原来的换行方式还原，
// 否则切一次源码模式就会被标为未保存，保存后整篇换行方式都被改掉（AC-W04）
function sourceText() {
  return state.eol === '\r\n' ? sourceEl.value.replace(/\r?\n/g, '\r\n') : sourceEl.value
}

function markDirty() {
  if (!state.dirty) {
    state.dirty = true
    reportState()
  }
}

function reportState() {
  $('docName').textContent = state.name
  $('dirtyDot').hidden = !state.dirty
  const title = `${state.dirty ? '● ' : ''}${state.name} — Markdown 记事本`
  document.title = title
  api.reportState({ dirty: state.dirty, path: state.path, title })
  folderNav?.render()
}

const draftKey = () => 'draft:' + (state.path || 'untitled')

const afterChange = debounce(() => {
  const md = currentMarkdown()
  const dirty = md !== state.savedMd
  if (dirty !== state.dirty) {
    state.dirty = dirty
    reportState()
  }
  // 草稿由主进程直接写入磁盘文件，程序被强制结束也不会丢失
  if (dirty) api.saveDraft(draftKey(), md)
  else api.clearDraft(draftKey())
  updateOutline()
  updateStats(md)
}, 300)

// 阅读记录按文件夹记：文章所在的文件夹和篇目树的根都记，打开任意一层文件夹都能回到上次那一篇（§6.1b）
function rememberFolder(path, mode, root = null) {
  const r = root || (folderNav.nav.dir && isWithin(path, folderNav.nav.dir) ? folderNav.nav.dir : null)
  const keys = [dirOf(path)]
  if (r && !sameFile(r, dirOf(path))) keys.push(r)
  for (const k of keys) api.memorySet('folders', k, { file: path, mode: mode === 'read' ? 'read' : 'edit' })
}

// 清空撤销记录：上一篇的修改不能在这一篇里被「撤销」出来（AC-F19）。
// 只重新初始化撤销插件自己的状态，其他插件的状态保持不变。
function clearHistory() {
  const st = editor.state
  const plugins = st.plugins
  const hist = plugins.find((p) => p.key.startsWith('history$'))
  if (!hist) return
  const without = st.reconfigure({ plugins: plugins.filter((p) => p !== hist) })
  editor.view.updateState(without.reconfigure({ plugins }))
}

function loadDoc({ path = null, name = '未命名.md', content = '' }, { hash = '', root = null } = {}) {
  hideDraftBanner()
  backDecisions.clear()
  rememberPosition()
  state.path = path
  state.name = name
  state.eol = /\r\n/.test(content) ? '\r\n' : '\n'
  setDocDir(dirOf(path))
  // 载入不进撤销记录：否则打开文件 / 换篇后连按 Ctrl+Z 会把整篇撤销成空白（AC-F19）
  editor
    .chain()
    .command(({ tr }) => {
      tr.setMeta('addToHistory', false)
      return true
    })
    .setContent(content, false)
    .run()
  clearHistory()
  refreshIndex()
  // 以编辑器规范化后的 Markdown 作为“已保存”基准
  state.savedMd = editor.storage.markdown.getMarkdown()
  if (state.mode === 'source') sourceEl.value = content
  state.dirty = false
  reportState()
  updateOutline()
  updateStats(state.savedMd)
  // 光标放在第一处可输入文字的位置（文档以图片、HTML 块开头时不去选中它）
  const start = Selection.findFrom(editor.state.doc.resolve(0), 1, true) || Selection.atStart(editor.state.doc)
  editor.view.dispatch(editor.state.tr.setSelection(start))
  paperEl.scrollTop = 0
  if (state.mode === 'edit') editor.commands.focus(null, { scrollIntoView: false })
  checkDraft()
  // 篇目：新文档沿用当前文件夹，方便接着写；打开文件则切换到它所在的文件夹
  if (path) {
    rememberFolder(path, state.mode, root)
    // 在当前篇目树内跳转时树的根不变；打开文件夹时以它为根（§4.11 v1.4）
    // 单独打开一篇（启动时、双击、拖入、「打开」）且它在打开过的文件夹里：以那个文件夹为根，其他文件夹的文章也能看到、能选为翻页目标（§4.11 v1.5）
    if (root || (folderNav.nav.dir && isWithin(path, folderNav.nav.dir))) folderNav.setDir(root || dirOf(path), { root: !!root })
    else {
      folderNav.setDir(dirOf(path)) // 先显示所在文件夹，查到打开过的根后再换（不让篇目空着等）
      api.rootFor(path).then((r) => {
        if (r && state.path && sameFile(state.path, path) && isWithin(path, r) && !sameFile(folderNav.nav.dir, r)) {
          folderNav.setDir(r, { root: true })
          rememberFolder(path, state.mode, r)
        }
      })
    }
  } else folderNav.render()
  // 定位：带 #标题 时以标题为准，否则回到这一篇上次读到的位置
  state.restoring = true
  const my = (state.loadSeq = (state.loadSeq || 0) + 1)
  ;(async () => {
    const mem = path && !hash ? await api.memoryGet('files', path) : null
    requestAnimationFrame(() => {
      if (my !== state.loadSeq) return
      // 读取记录期间用户已经开始滚动：以用户的操作为准，不再强行跳回
      const userScrolled = paperEl.scrollTop > 1
      if (hash) scrollToHash(hash, false)
      else if (mem && !userScrolled) restorePosition(editor, paperEl, mem)
      state.restoring = false
    })
  })()
}

// ---------------- 草稿恢复 ----------------
async function checkDraft() {
  const key = draftKey()
  const draft = await api.loadDraft(key)
  if (key !== draftKey() || state.dirty) return // 期间已切换文档或开始编辑
  if (!draft || !draft.md || draft.md === state.savedMd) return
  const bar = document.createElement('div')
  bar.className = 'draft-banner'
  const time = new Date(draft.time).toLocaleString('zh-CN')
  bar.innerHTML = `<span>发现 ${time} 未保存的草稿</span><button class="btn" data-a="drop">丢弃</button><button class="btn primary" data-a="restore">恢复</button>`
  bar.querySelector('[data-a=restore]').onclick = () => {
    api.clearDraft(key) // 恢复后由本窗口重新保存草稿；认领的孤儿草稿（程序退出前另一个窗口留下的）随之删除
    setContentKeepDirty(draft.md)
    hideDraftBanner()
  }
  bar.querySelector('[data-a=drop]').onclick = () => {
    api.clearDraft(key)
    hideDraftBanner()
  }
  $('bannerSlot').appendChild(bar)
}
function hideDraftBanner() {
  document.querySelector('.draft-banner')?.remove()
}
function setContentKeepDirty(md) {
  if (state.mode === 'source') sourceEl.value = md
  editor.commands.setContent(md, false)
  refreshIndex()
  state.dirty = true
  reportState()
  afterChange()
}

// ---------------- 文件操作 ----------------
async function okToDiscard() {
  if (!state.dirty) return true
  const choice = await api.confirmDiscard()
  if (choice === 'cancel') return false
  if (choice === 'save') return await save(false)
  api.clearDraft(draftKey())
  return true
}

async function save(saveAs) {
  const content = currentMarkdown()
  // 保存失败时主进程会弹出系统对话框说明原因，这里只需保持未保存状态
  // 新文档的另存为默认定位到当前篇目所在的文件夹
  const folder = folderNav.nav.dir
  const defaultName = !state.path && folder ? folder.replace(/[\\/]+$/, '') + '\\' + state.name : state.name
  const oldPath = state.path
  const oldRaw = state.savedMd == null ? null : splitFrontMatter(state.savedMd).raw
  const res = await api.saveFile({ path: state.path, content, saveAs, defaultName })
  if (!res || res.error) return false
  {
    api.clearDraft(draftKey())
    state.path = res.path
    state.name = res.name
    setDocDir(dirOf(res.path))
    folderNav.setDir(dirOf(res.path), { force: true }) // 另存到其他文件夹时篇目随之切换
    state.savedMd = content
    state.dirty = false
    reportState()
    // 翻页索引双向对应：同步另一篇（§4.13b）
    const synced = await syncBacklinks(oldPath, res.path, oldRaw, splitFrontMatter(content).raw)
    toast(synced.length ? `已保存 · 同步了${synced.join('、')}` : '已保存')
    return true
  }
}

async function openViaDialog() {
  if (!(await okToDiscard())) return
  const doc = await api.openDialog()
  if (doc?.error) return
  if (doc) loadDoc(doc)
}

async function newDoc() {
  if (!(await okToDiscard())) return
  loadDoc({})
}

// ---------------- 视图 ----------------
// 命令（按钮、快捷键）：再次触发同一模式时回到编辑
function setMode(mode) {
  applyMode(mode === state.mode ? 'edit' : mode)
}
function applyMode(mode) {
  if (mode === state.mode) return
  const prev = state.mode
  if (prev === 'source' && mode !== 'source') {
    // 源码 → 富文本
    editor.commands.setContent(sourceText(), false)
    refreshIndex()
  }
  if (mode === 'source') {
    sourceEl.value = editor.storage.markdown.getMarkdown()
  }
  state.mode = mode
  document.body.dataset.mode = mode
  $('editor').hidden = mode === 'source'
  sourceEl.hidden = mode !== 'source'
  editor.setEditable(mode === 'edit')
  btn('source').classList.toggle('active', mode === 'source')
  modeSwitch.set(mode === 'read' ? 'read' : 'edit') // 源码也是编辑，滑块停在「编辑」
  if (mode === 'source') sourceEl.focus()
  else if (mode === 'edit') editor.commands.focus(undefined, { scrollIntoView: false })
  if (state.path) rememberFolder(state.path, mode)
  updateOutline()
  toolbar.refresh()
  folderNav?.render()
}

function toggleOutline() {
  const hidden = document.body.classList.toggle('no-outline')
  btn('outline').classList.toggle('active', !hidden)
  try {
    localStorage.setItem('outlineHidden', hidden ? '1' : '0')
  } catch {}
}

const isDark = () =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches
function syncThemeIcon() {
  btn('theme').innerHTML = icons[isDark() ? 'sun' : 'moon']
}
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
  api.setTheme(theme || 'system')
  syncThemeIcon()
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeIcon)
function toggleTheme() {
  const cur =
    document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const next = cur === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  try {
    localStorage.setItem('theme', next)
  } catch {}
}

// ---------------- 大纲 & 统计 ----------------
function updateOutline() {
  const list = $('outlineList')
  const items = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') items.push({ level: node.attrs.level, text: node.textContent, pos })
    return node.type.name !== 'heading'
  })
  outlineItems = items
  list.replaceChildren(
    ...items.map((it) => {
      const li = document.createElement('li')
      li.className = 'lv' + it.level
      li.textContent = it.text || '（空标题）'
      li.title = it.text
      li.onclick = () => gotoHeadingPos(it.pos)
      return li
    })
  )
  if (!items.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = '添加标题后，这里会显示大纲'
    list.appendChild(li)
  }
  updateActiveHeading()
}

// 大纲中标出当前阅读位置所在的标题（§4.11）
let outlineItems = []
function updateActiveHeading() {
  const lis = $('outlineList').querySelectorAll('li:not(.empty)')
  if (!lis.length) return
  const top = paperEl.getBoundingClientRect().top + 90
  let idx = 0
  outlineItems.forEach((it, i) => {
    // 刚编辑完时大纲里记的位置可能还没更新，可能指到文字节点上，跳过（AC-P06）
    const dom = editor.view.nodeDOM(it.pos)
    if (dom && dom.nodeType === 1 && dom.getBoundingClientRect().top <= top) idx = i
  })
  lis.forEach((li, i) => li.classList.toggle('current', i === idx))
}
paperEl.addEventListener('scroll', debounce(updateActiveHeading, 60), { passive: true })

function updateStats(md) {
  const text = state.mode === 'source' ? md : editor.state.doc.textContent
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length
  const words = (text.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length
  $('stats').textContent = `${(cjk + words).toLocaleString('zh-CN')} 字`
}

// ---------------- 连续写作：篇目、跳转、阅读位置 ----------------
let sideChoice = null
try {
  sideChoice = localStorage.getItem('sideTab')
} catch {}
const sideSwitch = createSegmented({
  options: [
    { value: 'files', label: '篇目' },
    { value: 'outline', label: '大纲' },
  ],
  value: sideChoice || 'outline',
  label: '篇目或大纲',
  onChange: (v) => {
    setSideTab(v)
    sideChoice = v
    try {
      localStorage.setItem('sideTab', v)
    } catch {}
  },
})
$('sideSlot').appendChild(sideSwitch.el)
function setSideTab(v) {
  document.body.dataset.side = v
  sideSwitch.set(v)
}
setSideTab(sideChoice || 'outline')

const folderNav = createFolderNav({
  api,
  listEl: $('filesList'),
  footEl: $('folderFoot'),
  pagerEl: $('pager'),
  getCurrent: () => ({ path: state.pendingPath || state.path, dirty: state.dirty }),
  onOpen: (p) => gotoFile(p),
  onOpenFolder: () => runCommand('openFolder'),
  getIndex: () => state.index,
  isEditing: () => state.mode === 'edit',
  onTurn: (side) => goSide(side),
  onEditIndex: (side) => editIndex(side),
  onMissing: (x) => api.resolveLink(state.path, x.link), // 与文中链接相同的「找不到」提示（§4b）
  onListed: async (nav) => {
    refreshIndex(true) // 篇目变化后，指定的目标是否存在可能随之变化
    // 默认段：有 2 篇及以上时显示篇目；用户手动选过则尊重选择（§4.11）
    if (!sideChoice) setSideTab(nav.files.length >= 2 ? 'files' : 'outline')
    // 当前篇在资源管理器里被删除：保留内容并标为未保存（AC-N12）
    if (state.path && isWithin(state.path, nav.dir) && !nav.truncated && !nav.files.some((f) => sameFile(f.path, state.path))) {
      const st = await api.statPath(state.path)
      if (!st.exists) {
        state.savedMd = null
        state.dirty = true
        reportState()
      }
    }
  },
})

// 翻页动效（§6.6）：格式栏和底部翻页卡片不碎成粒子
const fxExcludes = () =>
  [document.querySelector('.formatbar-wrap'), $('pager')]
    .map((el) => el && el.getBoundingClientRect())
    .filter((r) => r && r.width > 0 && r.height > 0)
    .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height + 12 }))
const pageTurn = createPageTurn({ api, paperEl, sheetEl: document.querySelector('.sheet'), contentEl: $('editor'), getExcludes: fxExcludes })
// 链接跳转动效（§6.6b）：文中链接打开另一篇时，旧页抖动、炸成粒子随风飘散，再聚拢成新页
const linkBurst = createLinkBurst({
  api,
  paperEl,
  sheetEl: document.querySelector('.sheet'),
  contentEl: $('editor'),
  getExcludes: fxExcludes,
  isSettled: () => !state.restoring,
})

// 翻页方向：按篇目顺序，往后翻为 1、往前翻为 -1；不在同一篇目列表中时为 0（不播放）
function turnDirection(from, p) {
  const files = folderNav.siblingsOf(from) // 只在同一个文件夹内（§4.13、§6.6）
  if (!from) return 0
  const i = files.findIndex((f) => sameFile(f.path, from))
  const j = files.findIndex((f) => sameFile(f.path, p))
  if (i < 0 || j < 0 || i === j) return 0
  return j > i ? 1 : -1
}

// 在篇目之间跳转（篇目、上一篇/下一篇、文中链接）：始终在当前窗口打开；模式保持（§6.1）
// 翻页动效需要先截图（约 40ms）：期间「正在前往的那一篇」记在 pendingPath，
// 连续快速按 Ctrl+] 时，下一次以它为起点，不会把几次按键合并成一次。
async function gotoFile(p, { hash = '', mode = null, turn = true, root = null, dir: turnDir = null, effect = 'turn' } = {}) {
  const from = state.pendingPath || state.path
  if (from && sameFile(p, from)) {
    if (hash && !state.pendingPath) scrollToHash(hash)
    if (root) folderNav.setDir(root, { root: true })
    return true
  }
  if (await api.focusIfOpen(p)) return false
  if (!(await okToDiscard())) return false
  const dir = turn ? (turnDir ?? turnDirection(from, p)) : 0
  state.pendingPath = p
  try {
    const doc = await api.readFile(p)
    if (!doc || doc.error) return false
    const show = () => {
      if (state.mode === 'source') applyMode('edit') // 源码模式只针对当前这一篇
      if (mode && mode !== state.mode) applyMode(mode)
      loadDoc(doc, { hash, root })
    }
    // 文中链接用链接跳转动效（同文件夹、跨文件夹都播放）；其余按翻页动效
    if (effect === 'burst' && turn) {
      pageTurn.finish()
      await linkBurst.run(show)
    } else {
      linkBurst.finish()
      await pageTurn.run(dir, show)
    }
    return true
  } finally {
    if (state.pendingPath === p) state.pendingPath = null
  }
}

async function openFolder(dir) {
  const res = await api.listFolder(dir)
  const all = res.all || res.files || []
  if (!all.length) return toast('这个文件夹里没有 Markdown 文件', 'info')
  // 记住读到哪里：回到上次那一篇（可能在子文件夹里）和当时的模式（§6.1b）；没有记录时打开第一层的第一篇
  const mem = await api.memoryGet('folders', dir)
  api.memorySet('roots', res.dir, {}) // 记住打开过的文件夹：以后单独打开其中一篇时仍以它为篇目树的根
  const last = mem && all.find((f) => sameFile(f.path, mem.file))
  const first = (res.files && res.files[0]) || all[0]
  await gotoFile(last ? last.path : first.path, { mode: last ? mem.mode : null, turn: false, root: res.dir })
}

function gotoHeadingPos(pos, smooth = true) {
  // 先移动光标（不滚动），再平滑滚动，避免聚焦时浏览器自行滚动打断动画
  if (state.mode === 'edit') editor.chain().setTextSelection(pos + 1).focus(undefined, { scrollIntoView: false }).run()
  scrollToPos(editor, paperEl, pos, smooth)
}
function scrollToHash(hash, smooth = true) {
  const pos = findHeading(editor, hash)
  if (pos == null) return toast(`找不到标题“${hash}”`, 'info')
  gotoHeadingPos(pos, smooth)
}

// 链接：网页 → 系统浏览器；#标题 → 本文滚动；本地文件 → 主进程判断（Markdown 在程序内打开，其他只在资源管理器中显示）
async function handleLink(href) {
  href = String(href || '').trim()
  if (!href) return
  if (/^(https?:|mailto:)/i.test(href)) return api.openExternal(href)
  if (href.startsWith('#')) return scrollToHash(href.slice(1))
  const isDrive = /^[a-zA-Z]:[\\/]/.test(href)
  if (!isDrive && /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return // javascript: 等其他协议一律忽略
  const r = await api.resolveLink(state.path, href)
  if (r.kind === 'md') gotoFile(r.path, { hash: r.hash, effect: 'burst' })
}

// 链接的悬停提示：显示目标
setTipResolver((target) => {
  const a = target.closest?.('.prose a[href]')
  if (!a) return null
  const href = a.getAttribute('href')
  const key = state.mode === 'edit' ? 'Ctrl+单击' : ''
  if (/^(https?:|mailto:)/i.test(href)) return { el: a, tip: href, key }
  let [file, hash] = href.split('#')
  try {
    file = decodeURIComponent(file)
    hash = hash && decodeURIComponent(hash)
  } catch {}
  if (!file) return { el: a, tip: `跳到“${hash}”`, key }
  const name = file.split(/[\\/]/).pop()
  return { el: a, tip: `打开 ${name}${hash ? ` 的“${hash}”` : ''}`, key }
})

// 阅读位置：滚动停下后、离开这一篇前记录
function rememberPosition() {
  if (!state.path || state.restoring || state.mode === 'source') return
  api.memorySet('files', state.path, capturePosition(editor, paperEl))
}
paperEl.addEventListener('scroll', debounce(rememberPosition, 500), { passive: true })
// 点击正文下方的留白：光标移到文末（与点击正文空白处一致）
$('scrollTail').addEventListener('mousedown', (e) => {
  if (state.mode !== 'edit') return
  e.preventDefault()
  editor.commands.focus('end')
})
window.addEventListener('beforeunload', rememberPosition)

// ---------------- 翻页索引（设计规范 §4.13b） ----------------
const isAbsPath = (p) => /^[a-zA-Z]:[\\/]/.test(p)
// 相对当前文档所在文件夹解析路径（与文中链接相同：/ 或 \ 分隔、可用 ..、可写 %20 编码）
function joinPath(base, rel) {
  rel = rel.replace(/^file:\/\/\/?/i, '')
  try {
    if (/%[0-9a-f]{2}/i.test(rel)) rel = decodeURIComponent(rel)
  } catch {}
  const parts = (isAbsPath(rel) ? rel : `${base}\\${rel}`).split(/[\\/]+/)
  const out = []
  for (const seg of parts) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length > 1) out.pop()
    } else out.push(seg)
  }
  return out.join('\\')
}
// 从当前文档到目标的相对路径，写进属性区（/ 分隔）；不在同一个盘时写完整路径
function relLink(fromPath, to) {
  const a = dirOf(fromPath).split(/[\\/]+/).filter(Boolean)
  const b = to.split(/[\\/]+/).filter(Boolean)
  if (a[0].toLowerCase() !== b[0].toLowerCase()) return b.join('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i].toLowerCase() === b[i].toLowerCase()) i++
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/')
}
const currentFrontMatter = () => {
  const first = editor.state.doc.firstChild
  return first?.type.name === 'frontMatter' ? first.attrs.raw : null
}
const existCache = new Map() // 篇目树以外的目标是否存在（避免卡片闪烁）
let ixKey = null
let ixSeq = 0
// 由属性区算出翻页目标；篇目树内的目标立即确定，树外的再异步确认是否存在
function refreshIndex(force = false) {
  const raw = currentFrontMatter()
  const key = `${state.path}\n${raw}`
  if (!force && key === ixKey) return
  const changed = key !== ixKey
  ixKey = key
  const parsed = parseIndex(raw)
  const out = {}
  const outside = []
  for (const side of ['prev', 'next']) {
    const e = parsed[side]
    if (!e) continue
    if (e.hide) {
      out[side] = { hide: true }
      continue
    }
    const [file, ...h] = e.link.split('#')
    const name = file.split(/[\\/]/).pop() || file
    if (!state.path && !isAbsPath(file)) {
      out[side] = { exists: false, name, link: e.link, text: e.text }
      continue
    }
    const p = joinPath(dirOf(state.path) || '', file)
    const inTree = folderNav.nav.files.some((f) => sameFile(f.path, p))
    out[side] = { path: p, hash: h.join('#'), name, text: e.text, link: e.link, exists: inTree || (existCache.get(p.toLowerCase()) ?? true) }
    if (!inTree) outside.push(out[side])
  }
  state.index = out
  const my = ++ixSeq
  if (changed) folderNav.render()
  if (!outside.length) return
  Promise.all(
    outside.map(async (x) => {
      const st = await api.statPath(x.path)
      const ok = st.exists && !st.isDir
      existCache.set(x.path.toLowerCase(), ok)
      const diff = ok !== x.exists
      x.exists = ok
      return diff
    }),
  ).then((diffs) => my === ixSeq && diffs.some(Boolean) && folderNav.render())
}

// 上一篇 / 下一篇（卡片、Ctrl+[ / Ctrl+]）：按指定的目标或默认顺序；动效方向按卡片
async function goSide(side) {
  // 上一次翻页还在读取文件时，等新的一篇载入后再以它的索引为准
  for (let i = 0; state.pendingPath && i < 120; i++) await new Promise((r) => setTimeout(r, 16))
  const x = folderNav.target(side)
  if (!x) return
  if (x.kind === 'missing') return api.resolveLink(state.path, x.link)
  if (x.kind !== 'file') return
  await gotoFile(x.path, { hash: x.hash, dir: side === 'next' ? 1 : -1 })
}

// 改写属性区里的 prev / next：作为一次普通修改（可撤销、标为未保存）
function applyIndex(side, value) {
  const doc = editor.state.doc
  const first = doc.firstChild
  const oldRaw = currentFrontMatter()
  const raw = setIndexInRaw(oldRaw, side, value)
  if (raw === oldRaw) return false
  const tr = editor.state.tr
  const fm = editor.schema.nodes.frontMatter
  if (oldRaw !== null && raw === null) {
    if (doc.childCount === 1) tr.replaceWith(0, first.nodeSize, editor.schema.nodes.paragraph.create())
    else tr.delete(0, first.nodeSize)
  } else if (oldRaw !== null) tr.setNodeMarkup(0, null, { raw })
  else tr.insert(0, fm.create({ raw }))
  tr.setMeta(FM_META, true)
  editor.view.dispatch(tr)
  return true
}

// 编辑模式下点卡片上的「更改」或占位卡片：选择翻到哪一篇
async function editIndex(side) {
  if (state.mode !== 'edit' || !state.path) return
  const word = side === 'prev' ? '上一篇' : '下一篇'
  const x = folderNav.target(side)
  const cur = state.index[side]
  const root = folderNav.nav.dir
  // 与侧栏篇目树相同的可折叠树（§4.13b）：从根到本篇所在文件夹的那一串展开，其他文件夹收起，点开才显示
  const rootClean = root ? root.replace(/[\\/]+$/, '') : ''
  const relOf = (p) => (root && isWithin(p, root) ? p.slice(rootClean.length + 1).replace(/\\/g, '/') : p.split(/[\\/]/).pop())
  const open = new Set()
  const toNodes = (list) =>
    list.map((c) => {
      if (c.type === 'dir') {
        const here = state.path && isWithin(state.path, c.path)
        if (here) open.add(relOf(c.path))
        return { type: 'dir', key: relOf(c.path), label: c.name, note: here && sameFile(dirOf(state.path), c.path) ? '本篇所在' : '', children: toNodes(c.children || []) }
      }
      const self = sameFile(c.path, state.path)
      return {
        type: 'file',
        key: relOf(c.path),
        value: c.path,
        title: splitName(c.name).title + (self ? '（本篇）' : ''),
        sub: c.name,
        current: x?.kind === 'file' && sameFile(x.path, c.path),
        disabled: self,
      }
    })
  const tree = toNodes(folderNav.nav.tree || [])
  const buttons = [{ label: '其他位置…', value: 'other', left: true }]
  if (cur) buttons.push({ label: '恢复默认顺序', value: 'default' })
  if (!cur?.hide) buttons.push({ label: '不显示', value: 'hide' })
  const r = await pickItem({ title: `指定${word}`, placeholder: '搜索篇名或路径', rootName: folderNav.nav.name, tree, open, buttons, empty: '没有找到，可以点「其他位置…」' })
  let value
  let msg
  if (!r) return editor.commands.focus(undefined, { scrollIntoView: false })
  if (r.action === 'default') {
    value = undefined
    msg = `${word}已恢复默认顺序`
  } else if (r.action === 'hide') {
    value = false
    msg = `已设为不显示${word}`
  } else {
    let p = r.value
    if (r.action === 'other') {
      p = await api.pickMarkdown(`选择${word}`, dirOf(state.path))
      if (!p) return editor.commands.focus(undefined, { scrollIntoView: false })
      if (sameFile(p, state.path)) return toast(`${word}不能是这一篇自己`, 'info')
    }
    value = relLink(state.path, p)
    msg = `已指定${word}：${splitName(p.split(/[\\/]/).pop()).title}`
    await allowBacklink(p, side === 'next' ? 'prev' : 'next', state.path) // 有冲突时现在就问，保存时照此处理
  }
  editor.commands.focus(undefined, { scrollIntoView: false })
  if (applyIndex(side, value)) toast(msg)
}
// ---------------- 双向对应（§4.13b）：保存时同步另一篇 ----------------
const NOTE_RE = /\.(md|markdown|mdown|mkd)$/i
const OPP = { prev: 'next', next: 'prev' }
const WORD = { prev: '上一篇', next: '下一篇' }
const titleOf = (p) => splitName(String(p || '').split(/[\\/]/).pop()).title
// 另一篇已指定为别的篇时用户的选择（本篇打开期间有效）：「路径|方向」→ true 改 / false 保留
const backDecisions = new Map()
// 某一篇属性区里的一项指向的文件（未指定、不显示时为 null）
const entryPath = (fromPath, e) => (e && !e.hide && fromPath ? joinPath(dirOf(fromPath), e.link.split('#')[0]) : null)

// 读另一篇的原文；不存在、不是 Markdown、就是本篇时返回 null（不弹任何提示）
async function readOther(p) {
  if (!p || !NOTE_RE.test(p) || sameFile(p, state.path)) return null
  const st = await api.statPath(p)
  if (!st.exists || st.isDir) return null
  const doc = await api.readFile(p)
  return doc && !doc.error ? doc.content : null
}

// 另一篇 p 的 side 一项要改为指向 me：未指定或已指向 me 时直接改；已指定为别的篇（或不显示）时询问，每篇每个方向只问一次
async function allowBacklink(p, side, me, text) {
  const key = `${p.toLowerCase()}|${side}`
  if (backDecisions.has(key)) return backDecisions.get(key)
  if (text === undefined) text = await readOther(p)
  if (text == null) return false
  const cur = parseIndex(splitFrontMatter(text).raw)[side]
  const curPath = entryPath(p, cur)
  if (!cur || (curPath && sameFile(curPath, me))) return true
  const message = cur.hide
    ? `「${titleOf(p)}」已经设为不显示${WORD[side]}。要改为「${titleOf(me)}」吗？`
    : `「${titleOf(p)}」的${WORD[side]}已经指定为「${cur.text || titleOf(curPath)}」。要改为「${titleOf(me)}」吗？`
  const ok =
    (await askChoice({
      title: '同步翻页顺序',
      message,
      buttons: [
        { label: '保留原来的', value: false },
        { label: `改为「${titleOf(me)}」`, value: true, primary: true },
      ],
    })) === true
  backDecisions.set(key, ok)
  return ok
}

// 改另一篇 p 的 side 一项。decide(当前项, 当前指向的文件, 原文) 返回 { value } / { remove: true, pointsTo } / null
// 那一篇正在别的窗口打开时交给那个窗口改（标为未保存），否则直接改写文件。改了返回「「番外」的上一篇」
async function changeOther(p, side, decide) {
  const text = await readOther(p)
  if (text == null) return null
  const cur = parseIndex(splitFrontMatter(text).raw)[side]
  const d = await decide(cur, entryPath(p, cur), text)
  if (!d) return null
  const value = d.remove ? undefined : d.value
  const label = `「${titleOf(p)}」的${WORD[side]}`
  const payload = { side, value: value === undefined ? null : value, from: state.path, onlyIfPointsTo: d.remove ? d.pointsTo : null }
  if (await api.indexElsewhere(p, payload)) return label
  const out = setIndexInText(text, side, value)
  if (out === text) return null
  const res = await api.saveFile({ path: p, content: out, saveAs: false })
  return res && !res.error ? label : null
}

// 保存后：比较保存前后本篇的 prev / next，把变化同步到对应的另一篇
async function syncBacklinks(oldPath, newPath, oldRaw, newRaw) {
  const done = []
  if (!newPath) return done
  const before = parseIndex(oldRaw)
  const after = parseIndex(newRaw)
  const me = [newPath, oldPath].filter(Boolean)
  const isMe = (q) => !!q && me.some((m) => sameFile(q, m))
  for (const side of ['prev', 'next']) {
    const opp = OPP[side]
    const o = entryPath(oldPath, before[side])
    const n = entryPath(newPath, after[side])
    const same = o && n && sameFile(o, n)
    if (same && oldPath && sameFile(oldPath, newPath)) continue // 这一项没变
    // 原来的目标：它的反方向正指向本篇时删掉
    if (o && !same) {
      const r = await changeOther(o, opp, (_cur, curPath) => (isMe(curPath) ? { remove: true, pointsTo: me } : null))
      if (r) done.push(r)
    }
    // 新的目标：反方向写成本篇
    if (n) {
      const r = await changeOther(n, opp, async (_cur, curPath, text) => {
        if (curPath && sameFile(curPath, newPath)) return null // 已经对应
        if (isMe(curPath)) return { value: relLink(n, newPath) } // 另存为：跟到新位置
        return (await allowBacklink(n, opp, newPath, text)) ? { value: relLink(n, newPath) } : null
      })
      if (r) done.push(r)
    }
  }
  return done
}

// 另一个窗口改了翻页顺序、这一篇需要对应时（这一篇在本窗口打开）
api.onApplyIndex(({ side, value, from, onlyIfPointsTo }) => {
  if (onlyIfPointsTo) {
    const e = state.index[side]
    if (!e || e.hide || !e.path || !onlyIfPointsTo.some((q) => q && sameFile(q, e.path))) return
  }
  if (state.mode === 'source') applyMode('edit')
  if (applyIndex(side, value === null ? undefined : value)) {
    toast(`「${titleOf(from)}」改了翻页顺序，这一篇的${WORD[side]}已同步，记得保存`, 'info')
  }
})

// 点「属性」小标签：到源码模式查看和修改
window.addEventListener('front-matter-open', () => state.mode === 'edit' && setMode('source'))

// ---------------- 命令分发 ----------------
async function runCommand(cmd) {
  switch (cmd) {
    case 'new':
      return newDoc()
    case 'open':
      return openViaDialog()
    case 'save':
      return save(false)
    case 'saveAs':
      return save(true)
    case 'saveThenClose':
      if (await save(false)) api.closeNow()
      return
    case 'outline':
      return toggleOutline()
    case 'source':
      return setMode('source')
    case 'read':
      return setMode('read')
    case 'openFolder': {
      const dir = await api.pickFolder()
      if (dir) await openFolder(dir)
      return
    }
    case 'prevDoc':
      return goSide('prev')
    case 'nextDoc':
      return goSide('next')
    case 'theme':
      return toggleTheme()
    case 'editLink':
      return ctx.editLink()
    case 'unlink':
      return editor.chain().focus().extendMarkRange('link').unsetLink().run()
    case 'clearFormat':
      return editor.chain().focus().unsetAllMarks().clearNodes().run()
    case 'undo':
      if (state.mode === 'source') document.execCommand('undo')
      else editor.chain().focus().undo().run()
      return
    case 'redo':
      if (state.mode === 'source') document.execCommand('redo')
      else editor.chain().focus().redo().run()
      return
  }
}

api.onMenu(runCommand)
api.onOpenDoc(async (doc) => {
  if (state.path === doc.path) return
  if (!(await okToDiscard())) return
  loadDoc(doc)
})

// Ctrl+K 链接
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k' && state.mode === 'edit') {
    e.preventDefault()
    ctx.editLink()
  }
})

sourceEl.addEventListener('input', () => {
  markDirty()
  afterChange()
})
// 源码模式下 Tab 插入空格
sourceEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault()
    document.execCommand('insertText', false, '  ')
  }
})

// ---------------- 拖拽打开 ----------------
let dragDepth = 0
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return
  dragDepth++
  document.body.classList.add('dragging')
})
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return
  if (--dragDepth <= 0) {
    dragDepth = 0
    document.body.classList.remove('dragging')
  }
})
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault()
})
window.addEventListener(
  'drop',
  async (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepth = 0
    document.body.classList.remove('dragging')
    const files = [...e.dataTransfer.files]
    // 拖入文件夹：列出篇目并打开（上次读到的那一篇或第一篇）
    for (const f of files) {
      const p = api.getPathForFile(f)
      if (p && !/\.[^\/]+$/.test(f.name) && (await api.statPath(p)).isDir) return openFolder(p)
    }
    const md = files.filter((f) => /\.(md|markdown|mdown|mkd|txt)$/i.test(f.name))
    if (!md.length) return toast('只能打开 Markdown 或文本文件', 'info')
    const [first, ...rest] = md.map((f) => api.getPathForFile(f))
    if (!state.dirty && !state.path) {
      const doc = await api.readFile(first)
      if (!doc.error) loadDoc(doc)
    } else {
      api.openPath(first)
    }
    rest.forEach((p) => api.openPath(p))
  },
  true
)

// ---------------- 初始化 ----------------
try {
  const t = localStorage.getItem('theme')
  if (t) applyTheme(t)
  if (localStorage.getItem('outlineHidden') === '1') toggleOutline()
  else btn('outline').classList.add('active')
} catch {}
syncThemeIcon()
document.body.dataset.mode = 'edit'
loadDoc({})
// 自测脚本使用的调试入口
window.__test = { loadDoc, state, gotoFile, openFolder, folderNav, handleLink, pageTurn, linkBurst, editIndex, applyIndex, goSide, relLink, joinPath, save }
