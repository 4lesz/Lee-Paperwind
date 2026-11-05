// 通用界面组件：下拉面板、悬停提示、提示气泡、弹窗（设计规范 §4）
import { icons } from './icons.js'

// ---------------- 下拉面板 Popover（§4.3） ----------------
let openPop = null

export function closePopover() {
  if (!openPop) return
  const { el, anchor, onClose } = openPop
  openPop = null
  anchor.classList.remove('open')
  el.classList.add('leaving')
  setTimeout(() => el.remove(), 120)
  onClose?.()
}

/**
 * items: [{ label, html?, checked?, danger?, run }] 或 { separator: true }
 */
export function openPopover(anchor, items, { onClose, className = '' } = {}) {
  const same = openPop && openPop.anchor === anchor
  closePopover()
  if (same) return
  const el = document.createElement('div')
  el.className = 'popover ' + className
  el.setAttribute('role', 'menu')
  for (const it of items) {
    if (it.separator) {
      el.appendChild(Object.assign(document.createElement('div'), { className: 'pop-sep' }))
      continue
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'pop-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : '')
    b.setAttribute('role', 'menuitem')
    b.innerHTML = `<span class="pop-check">${it.checked ? icons.check : ''}</span><span class="pop-label">${it.html || escapeHtml(it.label)}</span>`
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => {
      closePopover()
      it.run()
    })
    el.appendChild(b)
  }
  document.body.appendChild(el)
  const r = anchor.getBoundingClientRect()
  const w = el.offsetWidth
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8)
  el.style.left = left + 'px'
  el.style.top = r.bottom + 6 + 'px'
  const maxH = window.innerHeight - r.bottom - 18
  el.style.maxHeight = Math.max(160, maxH) + 'px'
  anchor.classList.add('open')
  openPop = { el, anchor, onClose }
  el.querySelector('.checked')?.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('mousedown', (e) => {
  if (openPop && !openPop.el.contains(e.target) && !openPop.anchor.contains(e.target)) closePopover()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openPop) {
    e.stopPropagation()
    closePopover()
  }
}, true)
// 窗口失去焦点时收起（同苹果菜单）；自测脚本可通过 __keepPopoverOnBlur 关闭此行为
window.addEventListener('blur', () => window.__keepPopoverOnBlur || closePopover())
window.addEventListener('resize', closePopover)

// ---------------- 悬停提示 Tooltip（§4.1） ----------------
let tipEl = null
let tipTimer = null
function hideTip() {
  clearTimeout(tipTimer)
  tipEl?.classList.remove('show')
}
document.addEventListener('mouseover', (e) => {
  // 动态提示（如链接目标）优先；不在页面元素上写属性，避免干扰编辑器
  const dyn = tipResolver?.(e.target)
  const t = dyn ? dyn.el : e.target.closest?.('[data-tip]')
  if (!t) return
  clearTimeout(tipTimer)
  tipTimer = setTimeout(() => {
    if (!t.isConnected || t.classList.contains('open')) return
    if (!tipEl) {
      tipEl = document.createElement('div')
      tipEl.className = 'tooltip'
      document.body.appendChild(tipEl)
    }
    const info = dyn || { tip: t.dataset.tip, key: t.dataset.key }
    const key = info.key ? `<span class="tip-key">${escapeHtml(info.key)}</span>` : ''
    tipEl.innerHTML = `${escapeHtml(info.tip)}${key}`
    const r = t.getBoundingClientRect()
    const w = tipEl.offsetWidth
    tipEl.style.left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8) + 'px'
    const below = r.bottom + 8
    tipEl.style.top = (below + 30 > window.innerHeight ? r.top - 36 : below) + 'px'
    tipEl.classList.add('show')
  }, 600)
})
document.addEventListener('mouseout', (e) => {
  const t = tipResolver?.(e.target)?.el || e.target.closest?.('[data-tip]')
  if (t && !t.contains(e.relatedTarget)) hideTip()
})
document.addEventListener('mousedown', hideTip, true)

// ---------------- 提示气泡 Toast（§4.10） ----------------
// kind: 'success'（✓）或 'info'（ⓘ，用于轻量提醒）
export function toast(msg, kind = 'success') {
  let el = document.querySelector('.toast')
  if (!el) {
    el = document.createElement('div')
    el.className = 'toast'
    document.body.appendChild(el)
  }
  el.innerHTML = `<span class="toast-icon ${kind}">${kind === 'info' ? icons.info : icons.check}</span>${escapeHtml(msg)}`
  el.classList.add('show')
  clearTimeout(el._t)
  el._t = setTimeout(() => el.classList.remove('show'), 1600)
}

// ---------------- 弹窗 Sheet（§4.7） ----------------
export function askFields({ title, fields, extraButton }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div')
    mask.className = 'modal-mask'
    mask.innerHTML = `
      <form class="modal" autocomplete="off">
        <div class="modal-title">${escapeHtml(title)}</div>
        ${fields
          .map(
            (f, i) =>
              `<label class="field"><span>${escapeHtml(f.label)}</span><input name="f${i}" placeholder="${escapeHtml(f.placeholder || '')}" /></label>`
          )
          .join('')}
        <div class="modal-actions">
          ${extraButton ? `<button type="button" class="btn" data-act="extra">${escapeHtml(extraButton.label)}</button>` : ''}
          <span class="spacer"></span>
          <button type="button" class="btn" data-act="cancel">取消</button>
          <button type="submit" class="btn primary">确定</button>
        </div>
      </form>`
    const form = mask.querySelector('form')
    const inputs = [...form.querySelectorAll('input')]
    fields.forEach((f, i) => (inputs[i].value = f.value || ''))
    const close = (v) => {
      document.body.classList.remove('modal-open')
      mask.classList.add('leaving')
      setTimeout(() => mask.remove(), 150)
      resolve(v)
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      close(inputs.map((i) => i.value.trim()))
    })
    form.querySelector('[data-act=cancel]').onclick = () => close(null)
    if (extraButton) {
      form.querySelector('[data-act=extra]').onclick = async () => {
        const v = await extraButton.run()
        if (v != null) inputs[extraButton.target].value = v
      }
    }
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(null)
      }
    })
    mask.addEventListener('mousedown', (e) => e.target === mask && close(null))
    document.body.appendChild(mask)
    document.body.classList.add('modal-open')
    inputs[0].focus()
    inputs[0].select()
  })
}

// ---------------- 询问（§4.7 样式）：返回所选按钮的 value，Esc / 点遮罩返回 null ----------------
export function askChoice({ title, message, buttons }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div')
    mask.className = 'modal-mask'
    mask.innerHTML = `
      <div class="modal ask-modal" role="alertdialog" aria-label="${escapeHtml(title)}">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-message">${escapeHtml(message)}</div>
        <div class="modal-actions">
          <span class="spacer"></span>
          ${buttons.map((b, i) => `<button type="button" class="btn${b.primary ? ' primary' : ''}" data-b="${i}">${escapeHtml(b.label)}</button>`).join('')}
        </div>
      </div>`
    const close = (v) => {
      document.body.classList.remove('modal-open')
      mask.classList.add('leaving')
      setTimeout(() => mask.remove(), 150)
      resolve(v)
    }
    mask.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => close(buttons[+b.dataset.b].value)))
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(null)
      }
    })
    mask.addEventListener('mousedown', (e) => e.target === mask && close(null))
    document.body.appendChild(mask)
    document.body.classList.add('modal-open')
    ;(mask.querySelector('.btn.primary') || mask.querySelector('.btn')).focus()
  })
}

// ---------------- 选择一篇（翻页索引 §4.13b）：可折叠的篇目树 ----------------
// tree：[{ type: 'dir', key, label, children } | { type: 'file', key, value, title, sub, current, disabled }]
// open：一开始展开的文件夹（key 的集合，通常是从根到本篇所在文件夹的那一串）；其他文件夹收起，点开才显示
// buttons：[{ label, value, left }]；返回 { value }（选了某一篇）、{ action }（点了底部按钮）或 null（取消）
export function pickItem({ title, placeholder = '搜索', rootName = '', tree, open = new Set(), buttons = [], empty = '没有可选的文章' }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div')
    mask.className = 'modal-mask'
    mask.innerHTML = `
      <div class="modal pick-modal" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="modal-title">${escapeHtml(title)}</div>
        <label class="field"><input class="pick-search" placeholder="${escapeHtml(placeholder)}" /></label>
        ${rootName ? `<div class="pick-root"><span class="pick-root-icon">${icons.folder}</span>${escapeHtml(rootName)}</div>` : ''}
        <ul class="pick-list" role="tree"></ul>
        <div class="modal-actions">
          ${buttons.filter((b) => b.left).map((b) => `<button type="button" class="btn" data-b="${buttons.indexOf(b)}">${escapeHtml(b.label)}</button>`).join('')}
          <span class="spacer"></span>
          ${buttons.filter((b) => !b.left).map((b) => `<button type="button" class="btn" data-b="${buttons.indexOf(b)}">${escapeHtml(b.label)}</button>`).join('')}
          <button type="button" class="btn" data-act="cancel">取消</button>
        </div>
      </div>`
    const input = mask.querySelector('.pick-search')
    const list = mask.querySelector('.pick-list')
    const opened = new Set(open)
    let rows = [] // 当前可见的行：{ node, depth, open }
    let active = -1
    const close = (v) => {
      document.body.classList.remove('modal-open')
      mask.classList.add('leaving')
      setTimeout(() => mask.remove(), 150)
      resolve(v)
    }
    const usable = (r) => r && !(r.node.type === 'file' && r.node.disabled)
    const setActive = (i) => {
      active = i
      list.querySelectorAll('li[data-row]').forEach((li) => li.classList.toggle('active', +li.dataset.row === i))
      list.querySelector(`li[data-row="${i}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    const matches = (f, q) => `${f.title} ${f.sub || ''} ${f.key}`.toLowerCase().includes(q)
    // 搜索时：只显示匹配的文章，以及通向它们的文件夹（自动展开）
    const hasMatch = (n, q) => (n.type === 'file' ? matches(n, q) : n.children.some((c) => hasMatch(c, q)))
    function build(q) {
      const out = []
      const walk = (list, depth) => {
        for (const n of list) {
          if (q && !hasMatch(n, q)) continue
          if (n.type === 'dir') {
            const isOpen = q ? true : opened.has(n.key)
            out.push({ node: n, depth, open: isOpen })
            if (isOpen) walk(n.children, depth + 1)
          } else out.push({ node: n, depth })
        }
      }
      walk(tree, 0)
      return out
    }
    function render(keepKey = null) {
      const q = input.value.trim().toLowerCase()
      rows = build(q)
      list.innerHTML = rows.length
        ? rows
            .map((r, i) => {
              const n = r.node
              if (n.type === 'dir') {
                return `<li class="pick-folder${r.open ? ' open' : ''}" role="treeitem" aria-expanded="${r.open}" data-row="${i}" data-key="${escapeHtml(n.key)}" style="--depth:${r.depth}">
                  <span class="pick-chev">${icons.chevron}</span><span class="pick-folder-icon">${icons.folder}</span><span class="pick-title">${escapeHtml(n.label)}</span>${n.note ? `<span class="pick-note">· ${escapeHtml(n.note)}</span>` : ''}</li>`
              }
              return `<li class="pick-item${n.current ? ' current' : ''}${n.disabled ? ' disabled' : ''}" role="treeitem" aria-disabled="${!!n.disabled}" data-row="${i}" data-key="${escapeHtml(n.key)}" style="--depth:${r.depth}">
                <span class="pick-check">${n.current ? icons.check : ''}</span>
                <span class="pick-title">${escapeHtml(n.title)}</span>
                <span class="pick-sub">${escapeHtml(n.sub || '')}</span></li>`
            })
            .join('')
        : `<li class="pick-empty">${escapeHtml(empty)}</li>`
      list.querySelectorAll('li[data-row]').forEach((li) => {
        const i = +li.dataset.row
        li.onmousemove = () => usable(rows[i]) && active !== i && setActive(i)
        li.onclick = () => activate(i)
      })
      let to = keepKey != null ? rows.findIndex((r) => r.node.key === keepKey) : -1
      if (to < 0) to = rows.findIndex((r) => r.node.type === 'file' && r.node.current && !r.node.disabled)
      if (to < 0) to = rows.findIndex((r) => r.node.type === 'file' && !r.node.disabled)
      if (to < 0) to = rows.findIndex(usable)
      setActive(to)
    }
    function toggle(i, want = null) {
      const r = rows[i]
      if (!r || r.node.type !== 'dir' || input.value.trim()) return
      const isOpen = opened.has(r.node.key)
      if (want === isOpen) return
      if (isOpen) opened.delete(r.node.key)
      else opened.add(r.node.key)
      render(r.node.key)
    }
    function activate(i) {
      const r = rows[i]
      if (!usable(r)) return
      if (r.node.type === 'dir') return toggle(i)
      close({ value: r.node.value })
    }
    input.addEventListener('input', () => render())
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        return close(null)
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        for (let i = active + d; i >= 0 && i < rows.length; i += d) {
          if (usable(rows[i])) return setActive(i)
        }
        return
      }
      // → 展开文件夹、← 收起（光标在文章上时跳回它所在的文件夹）；在搜索框里有文字时 ←/→ 用来移动光标
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !(e.target === input && input.value)) {
        const r = rows[active]
        if (!r) return
        e.preventDefault()
        if (r.node.type === 'dir') return toggle(active, e.key === 'ArrowRight')
        if (e.key === 'ArrowLeft') {
          for (let i = active - 1; i >= 0; i--) if (rows[i].node.type === 'dir' && rows[i].depth < r.depth) return setActive(i)
        }
        return
      }
      if (e.key === 'Enter' && e.target === input) {
        e.preventDefault()
        activate(active)
      }
    })
    mask.querySelector('[data-act=cancel]').onclick = () => close(null)
    mask.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => close({ action: buttons[+b.dataset.b].value })))
    mask.addEventListener('mousedown', (e) => e.target === mask && close(null))
    document.body.appendChild(mask)
    document.body.classList.add('modal-open')
    render()
    input.focus()
  })
}

// ---------------- 分段滑块 Segmented Control（§4.11 / §4.14） ----------------
// 点击另一段切换；在控件上左右拖动，松手停到较近的一侧；焦点在控件上时 ←/→ 切换
export function createSegmented({ options, value, onChange, tip, key, label }) {
  const el = document.createElement('div')
  el.className = 'segmented'
  el.setAttribute('role', 'radiogroup')
  if (label) el.setAttribute('aria-label', label)
  el.tabIndex = 0
  if (tip) el.dataset.tip = tip
  if (key) el.dataset.key = key
  el.style.setProperty('--seg-n', options.length)
  const thumb = document.createElement('div')
  thumb.className = 'seg-thumb'
  el.appendChild(thumb)
  const buttons = options.map((o) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'seg-item'
    b.tabIndex = -1
    b.setAttribute('role', 'radio')
    b.dataset.value = o.value
    b.textContent = o.label
    el.appendChild(b)
    return b
  })
  let current = value
  const idxOf = (v) => Math.max(0, options.findIndex((o) => o.value === v))
  function render() {
    const i = idxOf(current)
    thumb.style.transform = `translateX(${i * 100}%)`
    buttons.forEach((b, j) => {
      b.classList.toggle('on', j === i)
      b.setAttribute('aria-checked', j === i)
    })
    el.dataset.value = current
  }
  function choose(v) {
    if (v === current) return render()
    current = v
    render()
    onChange?.(v)
  }
  // 拖动 / 点击
  let drag = null
  el.addEventListener('mousedown', (e) => e.preventDefault()) // 不抢走编辑器焦点
  // 鼠标位置落在第几段
  const idxAt = (x, r) => Math.min(options.length - 1, Math.max(0, Math.floor(((x - r.left - 2) / (r.width - 4)) * options.length)))
  const pressOff = () => {
    el.classList.remove('pressing')
    buttons.forEach((b) => b.classList.remove('pressed'))
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const r = el.getBoundingClientRect()
    drag = { x0: e.clientX, r, moved: false, start: idxOf(current), at: idxAt(e.clientX, r) }
    // 按下的反馈：按在当前段上时滑块微缩；按在另一段上时那一段的文字变淡
    if (drag.at === drag.start) el.classList.add('pressing')
    else buttons[drag.at].classList.add('pressed')
    try {
      el.setPointerCapture(e.pointerId)
    } catch {}
  })
  el.addEventListener('pointermove', (e) => {
    if (!drag) return
    const dx = e.clientX - drag.x0
    if (Math.abs(dx) > 3 && !drag.moved) {
      drag.moved = true
      pressOff()
    }
    if (!drag.moved) return
    const seg = (drag.r.width - 4) / options.length
    const pos = Math.min(Math.max(drag.start * seg + dx, 0), seg * (options.length - 1))
    thumb.classList.add('dragging')
    thumb.style.transform = `translateX(${pos}px)`
    drag.pos = pos
    drag.seg = seg
  })
  let suppressClick = false
  const end = (e) => {
    if (!drag) return
    const d = drag
    drag = null
    thumb.classList.remove('dragging')
    pressOff()
    if (d.moved && d.seg) {
      suppressClick = true // 拖动结束后随之而来的 click 不再改变结果
      choose(options[Math.round(d.pos / d.seg)].value)
    } else if (e.type === 'pointerup') {
      // 鼠标点击：按下时捕获了指针，随后的 click 事件落在整个控件上、分不出点的是哪一段，
      // 所以在松开时按位置判断（松开的位置仍在控件内才算点击）
      const r = el.getBoundingClientRect()
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        suppressClick = true
        choose(options[idxAt(e.clientX, r)].value)
      }
    }
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  // 点击（键盘 Enter / 空格、辅助技术、脚本）；鼠标点击已在松开时处理
  el.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false
      return
    }
    const b = e.target.closest?.('.seg-item')
    if (b) choose(b.dataset.value)
  })
  el.addEventListener('keydown', (e) => {
    const i = idxOf(current)
    if (e.key === 'ArrowRight' && i < options.length - 1) choose(options[i + 1].value)
    else if (e.key === 'ArrowLeft' && i > 0) choose(options[i - 1].value)
    else return
    e.preventDefault()
  })
  render()
  return {
    el,
    get value() {
      return current
    },
    set(v) {
      current = v
      render()
    },
  }
}

// 悬停提示的动态内容（例如链接目标），返回 { tip, key } 或 null
let tipResolver = null
export function setTipResolver(fn) {
  tipResolver = fn
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
