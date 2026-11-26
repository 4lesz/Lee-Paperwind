// 连续写作：篇目树（含子文件夹）、上一篇 / 下一篇（PRD §3.6，设计规范 §4.11、§4.13）
import { icons } from './icons.js'
import { escapeHtml } from './ui.js'

// 文件名开头的编号：01- / 1. / 2_ / 1.2- / 第3章
const NUM_PREFIX = /^(\d+(?:[.\-_、]\d+)*[.\-_、\s]*|第\s*[\d一二三四五六七八九十百千]+\s*[章节篇回部集卷]\s*)/
export function splitName(fileName) {
  const base = fileName.replace(/\.(md|markdown|mdown|mkd)$/i, '')
  const m = base.match(NUM_PREFIX)
  if (m && m[0].length < base.length) {
    return { prefix: m[0].replace(/[.\-_、\s]+$/, ''), title: base.slice(m[0].length).trim() || base }
  }
  return { prefix: '', title: base }
}
const norm = (p) => (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
export const sameFile = (a, b) => !!a && !!b && norm(a) === norm(b)
export const dirOfPath = (p) => (p ? p.replace(/[\\/][^\\/]*$/, '') : null)
// p 是否在文件夹 root 之内（含 root 本身）
export const isWithin = (p, root) => !!p && !!root && (norm(p) === norm(root) || norm(p).startsWith(norm(root) + '\\'))

export function createFolderNav({ api, listEl, footEl, pagerEl, getCurrent, onOpen, onOpenFolder, onListed, getIndex, isEditing, onTurn, onEditIndex, onMissing, onNew, onRename }) {
  // dir：树的根；files：树里全部文章（按树的顺序）；tree：根下的条目
  const nav = { dir: null, name: '', files: [], tree: [], truncated: false }
  const expanded = new Set() // 手动展开的文件夹（本次运行期间保持）
  const collapsed = new Set() // 手动收起的文件夹（即使当前文章在里面也保持收起）
  let seq = 0

  // root：明确把 dir 作为新的根（打开文件夹）；否则 dir 在当前树内时保持原来的根
  async function setDir(dir, { force = false, root = false } = {}) {
    if (!dir) {
      nav.dir = null
      nav.files = []
      nav.tree = []
      api.watchFolder(null)
      render()
      onListed?.(nav)
      return nav
    }
    const target = !root && nav.dir && isWithin(dir, nav.dir) ? nav.dir : dir
    if (!force && nav.dir && sameFile(nav.dir, target)) {
      render()
      return nav
    }
    const my = ++seq
    const res = await api.listFolder(target)
    if (my !== seq) return nav // 期间又切换了文件夹
    if (!nav.dir || !sameFile(nav.dir, res.dir)) {
      expanded.clear()
      collapsed.clear()
    }
    nav.dir = res.dir
    nav.name = res.name
    nav.tree = res.tree || []
    nav.files = res.all || res.files || []
    nav.truncated = !!res.truncated
    api.watchFolder(res.dir)
    render()
    onListed?.(nav)
    return nav
  }

  // 某个文件夹下（不含更深层）的文章；dir 为根时就是第一层
  function filesIn(dir) {
    if (!dir || !nav.dir) return []
    if (sameFile(dir, nav.dir)) return nav.tree.filter((c) => c.type === 'file')
    const find = (list) => {
      for (const c of list) {
        if (c.type !== 'dir') continue
        if (sameFile(c.path, dir)) return c
        if (isWithin(dir, c.path)) return find(c.children)
      }
      return null
    }
    const node = find(nav.tree)
    return node ? node.children.filter((c) => c.type === 'file') : []
  }
  // 上一篇 / 下一篇只在当前文章所在的同一个文件夹内（§4.13 v1.4）
  const siblingsOf = (p) => filesIn(dirOfPath(p))
  const index = (list) => list.findIndex((f) => sameFile(f.path, getCurrent().path))
  const prev = () => {
    const list = siblingsOf(getCurrent().path)
    const i = index(list)
    return i > 0 ? list[i - 1] : null
  }
  const next = () => {
    const list = siblingsOf(getCurrent().path)
    const i = index(list)
    return i >= 0 && i < list.length - 1 ? list[i + 1] : null
  }

  // 文件夹是否展开：手动展开的、或当前文章所在路径上的（手动收起的除外）
  function isOpen(dirPath, curPath) {
    const k = norm(dirPath)
    if (collapsed.has(k)) return false
    return expanded.has(k) || (!!curPath && isWithin(curPath, dirPath))
  }
  function toggle(dirPath, curPath) {
    const k = norm(dirPath)
    if (isOpen(dirPath, curPath)) {
      expanded.delete(k)
      collapsed.add(k)
    } else {
      collapsed.delete(k)
      expanded.add(k)
    }
    render()
  }

  let lastCur = null
  function render() {
    const cur = getCurrent()
    // 切换到新的一篇时，它所在路径上手动收起的文件夹重新展开，保证当前文章可见
    if (cur.path && !sameFile(cur.path, lastCur)) {
      for (const k of [...collapsed]) if (isWithin(cur.path, k)) collapsed.delete(k)
      lastCur = cur.path
    }
    if (!nav.dir) {
      listEl.innerHTML = `<li class="files-empty"><p>打开一个文件后，这里会列出同一文件夹里的文章</p><button class="btn" type="button" data-act="open-folder">打开文件夹…</button></li>`
      listEl.querySelector('[data-act=open-folder]').onclick = () => onOpenFolder()
      footEl.hidden = true
    } else {
      const items = []
      const build = (list, depth) => {
        for (const c of list) {
          const li = document.createElement('li')
          li.style.setProperty('--depth', depth)
          li.dataset.path = c.path
          li.title = c.name
          const { prefix, title } = splitName(c.name)
          const label = `${prefix ? `<span class="file-prefix">${escapeHtml(prefix)}</span>` : ''}<span class="file-title">${escapeHtml(title)}</span>`
          if (c.type === 'dir') {
            const open = isOpen(c.path, cur.path)
            li.className = 'folder-item' + (open ? ' open' : '')
            li.setAttribute('aria-expanded', open ? 'true' : 'false')
            li.innerHTML = `<span class="folder-chev">${icons.chevron}</span>${label}`
            li.onclick = () => toggle(c.path, cur.path)
            items.push(li)
            if (open) build(c.children, depth + 1)
          } else {
            const current = sameFile(c.path, cur.path)
            li.className = 'file-item' + (current ? ' current' : '')
            li.innerHTML = `${label}${current && cur.dirty ? '<span class="file-dot"></span>' : ''}`
            li.onclick = () => !current && onOpen(c.path)
            li.oncontextmenu = (e) => {
              e.preventDefault()
              openFileMenu(e, c.path)
            }
            items.push(li)
          }
        }
      }
      build(nav.tree, 0)
      listEl.replaceChildren(...items)
      if (!nav.files.length) {
        // 空文件夹也能直接开工（PRD §3.6 v0.7）
        listEl.innerHTML = `<li class="files-empty"><p>这个文件夹里还没有 Markdown 文件</p><button class="btn" type="button" data-new-file>新建一篇</button></li>`
        listEl.querySelector('[data-new-file]').onclick = () => onNew?.()
      }
      footEl.hidden = false
      footEl.innerHTML = `<span class="folder-icon">${icons.folder}</span><span class="folder-name">${escapeHtml(nav.name)}</span>`
      footEl.title = nav.dir
    }
    if (renaming) mountRename()
    listEl.querySelector('.current')?.scrollIntoView({ block: 'nearest' })
    renderPager()
  }

  // ---- 右键菜单 / 就地改名（PRD §3.1 v0.10）----
  let renaming = null // 正在就地改名的文件路径
  function closeFileMenu() {
    document.querySelector('.files-menu')?.remove()
  }
  function openFileMenu(e, p) {
    closeFileMenu()
    const menu = document.createElement('div')
    menu.className = 'files-menu'
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = '重命名'
    b.onclick = () => {
      closeFileMenu()
      renaming = p
      render()
    }
    menu.append(b)
    document.body.append(menu)
    menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px'
    menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px'
    setTimeout(() => document.addEventListener('mousedown', closeFileMenu, { once: true }), 0)
  }
  function mountRename() {
    const p = renaming
    renaming = null
    const li = [...listEl.querySelectorAll('.file-item')].find((x) => sameFile(x.dataset.path, p))
    if (!li) return
    const input = document.createElement('input')
    input.className = 'file-rename'
    input.value = li.title.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '')
    input.setAttribute('aria-label', '重命名')
    li.replaceChildren(input)
    input.focus()
    input.select()
    let done = false
    const finish = async (commit) => {
      if (done) return
      done = true
      const v = input.value.trim()
      if (commit && v) await onRename?.(p, v)
      render()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
  }

  // 翻页目标：属性区里指定的优先（§4.13b），否则按同一文件夹内的文件名顺序（§4.13）
  // 返回 { kind: 'file', path, hash, title, custom } | { kind: 'missing', name, link, custom } | { kind: 'hidden', custom } | null
  function target(side) {
    const ix = getIndex?.()?.[side]
    if (ix) {
      if (ix.hide) return { kind: 'hidden', custom: true }
      if (!ix.exists) return { kind: 'missing', custom: true, name: ix.name, link: ix.link }
      return { kind: 'file', custom: true, path: ix.path, hash: ix.hash || '', title: ix.text || splitName(ix.name).title }
    }
    const f = side === 'prev' ? prev() : next()
    return f ? { kind: 'file', custom: false, path: f.path, hash: '', title: splitName(f.name).title } : null
  }

  function renderPager() {
    const cur = getCurrent()
    const editing = !!isEditing?.() && !!cur.path
    const t = { prev: target('prev'), next: target('next') }
    const shown = (x) => x && x.kind !== 'hidden'
    const anyCustom = t.prev?.custom || t.next?.custom
    // 有可翻的一侧就显示；编辑模式下打开了文件夹（或已有指定）时也显示，方便直接指定（§4.13b）
    const show = !!cur.path && (shown(t.prev) || shown(t.next) || (editing && (nav.files.length >= 2 || anyCustom)))
    if (!show) {
      pagerEl.replaceChildren()
      pagerEl.hidden = true
      return
    }
    pagerEl.hidden = false
    const word = { prev: '‹ 上一篇', next: '下一篇 ›' }
    const slot = (side) => {
      const x = t[side]
      const custom = editing && x?.custom
      const label = side === 'prev'
        ? `${word.prev}${custom ? '<span class="pager-custom"> · 已指定</span>' : ''}`
        : `${custom ? '<span class="pager-custom">已指定 · </span>' : ''}${word.next}`
      const edit = editing ? `<button type="button" class="pager-edit" data-side="${side}" data-tip="指定${side === 'prev' ? '上一篇' : '下一篇'}…" aria-label="指定${side === 'prev' ? '上一篇' : '下一篇'}">${icons.pencil}</button>` : ''
      if (shown(x)) {
        const title = x.kind === 'missing' ? `找不到 ${x.name}` : x.title
        return `<div class="pager-slot" data-side="${side}"><button type="button" class="pager-card ${side}${x.kind === 'missing' ? ' missing' : ''}" data-side="${side}">
          <span class="pager-label">${label}</span>
          <span class="pager-title">${escapeHtml(title)}</span></button>${edit}</div>`
      }
      if (!editing) return '<span class="pager-gap"></span>'
      // 空着的一侧：占位卡片，点击指定
      return `<div class="pager-slot" data-side="${side}"><button type="button" class="pager-card ghost" data-side="${side}">
        <span class="pager-label">${label}</span>
        <span class="pager-title">${x?.kind === 'hidden' ? '已隐藏 · 点击更改' : '＋ 指定…'}</span></button></div>`
    }
    pagerEl.innerHTML = slot('prev') + slot('next')
    pagerEl.querySelectorAll('.pager-card').forEach((b) => {
      const side = b.dataset.side
      b.onclick = () => {
        const x = target(side)
        if (b.classList.contains('ghost')) return onEditIndex?.(side)
        if (x?.kind === 'missing') return onMissing?.(x)
        if (x?.kind === 'file') onTurn ? onTurn(side, x) : onOpen(x.path)
      }
    })
    pagerEl.querySelectorAll('.pager-edit').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation()
        onEditIndex?.(b.dataset.side)
      }
    })
  }

  api.onFolderChanged(async (dir) => {
    if (nav.dir && sameFile(nav.dir, dir)) await setDir(dir, { force: true })
  })

  return { nav, setDir, render, prev, next, target, siblingsOf, refresh: () => nav.dir && setDir(nav.dir, { force: true }) }
}
