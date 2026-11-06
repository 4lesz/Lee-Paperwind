// 标题定位与阅读位置（设计规范 §4b、§6.1b）

// 与 GitHub / Typora 一致的标题锚点：转小写，去标点（中文保留），空格换成 -
export function slugify(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

export function headingAnchors(editor) {
  const seen = new Map()
  const out = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true
    const base = slugify(node.textContent)
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    out.push({ slug: n ? `${base}-${n}` : base, text: node.textContent, pos })
    return false
  })
  return out
}

export function findHeading(editor, hash) {
  let h = String(hash || '').replace(/^#/, '')
  try {
    h = decodeURIComponent(h)
  } catch {}
  const list = headingAnchors(editor)
  const want = h.toLowerCase()
  const hit = list.find((a) => a.slug === want) || list.find((a) => slugify(a.text) === slugify(h)) || list.find((a) => a.text.trim() === h.trim())
  return hit ? hit.pos : null
}

// 正文顶部被格式栏遮住的高度
export function topInset() {
  const wrap = document.querySelector('.formatbar-wrap')
  const visible = wrap && getComputedStyle(wrap).display !== 'none'
  return visible ? wrap.offsetHeight + 16 : 16
}

export function scrollToPos(editor, scroller, pos, smooth = true) {
  const dom = editor.view.nodeDOM(pos)
  if (!dom || dom.nodeType !== 1) return false
  const top = dom.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - topInset()
  scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
  return true
}

// 记录「屏幕顶部对应的段落」：序号 + 开头文字 + 段内偏移，另记一个比例作为兜底
export function capturePosition(editor, scroller) {
  const blocks = [...editor.view.dom.children]
  const line = scroller.getBoundingClientRect().top + topInset()
  let index = 0
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].getBoundingClientRect().bottom > line) {
      index = i
      break
    }
  }
  const b = blocks[index]
  const max = scroller.scrollHeight - scroller.clientHeight
  return {
    index,
    text: b ? b.textContent.slice(0, 60) : '',
    offset: b ? Math.round(line - b.getBoundingClientRect().top) : 0,
    ratio: max > 0 ? scroller.scrollTop / max : 0,
    top: scroller.scrollTop,
  }
}

export function restorePosition(editor, scroller, p) {
  if (!p) return false
  const blocks = [...editor.view.dom.children]
  let best = -1
  if (p.text) {
    let bestDist = Infinity
    blocks.forEach((b, i) => {
      if (b.textContent.slice(0, 60) === p.text && Math.abs(i - p.index) < bestDist) {
        best = i
        bestDist = Math.abs(i - p.index)
      }
    })
  }
  if (best >= 0) {
    const b = blocks[best]
    const top = b.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - topInset() + (p.offset || 0)
    scroller.scrollTop = Math.max(0, top)
  } else {
    scroller.scrollTop = (p.ratio || 0) * (scroller.scrollHeight - scroller.clientHeight)
  }
  return true
}
