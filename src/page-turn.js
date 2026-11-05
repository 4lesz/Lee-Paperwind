// 翻页动效（设计规范 §6.6）：旧页碎成粒子消散，新页按翻页方向滑入。
//
// 做法：翻页前由主进程截取正文区域的真实像素，铺在一块画布上把画面「定格」；
// 新的一篇在画布下面换好之后，把截图切成约 3px 的小方块（只取有内容的地方，保留原色），
// 从离开的一侧开始逐列飘散；同时新页从另一侧滑入。截图失败时只播放滑入，不影响翻页本身。

const SWEEP = 220 // 扫过全宽
const JITTER = 100 // 每颗粒子额外的随机延迟
const LIFE = 380 // 单颗粒子寿命
// 新页「先散后进」：等旧页粒子基本飘走再出现（产品负责人反馈：新页进来太早、太突兀）
const SLIDE_DELAY = 450
const SLIDE_DUR = 560
const SLIDE_DIST = 48
const GLIDE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const FADE = 'cubic-bezier(0.45, 0, 0.55, 1)' // 淡入慢起慢收：开头几乎不可见，最后才清晰
export const MAX_PARTICLES = 14000

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

export function parseRgb(css) {
  const m = /rgba?\(([^)]+)\)/.exec(css || '')
  if (!m) return [255, 255, 255]
  return m[1].split(',').slice(0, 3).map((v) => parseFloat(v))
}

// 截图 → 只含有内容的小方块
export function buildParticles(img, bg, excludes) {
  const { width: W, height: H, data } = img
  const near = (i) => Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) < 30
  const isContent = (x, y, s) => {
    const pts = [
      [x, y],
      [x + s - 1, y],
      [x, y + s - 1],
      [x + s - 1, y + s - 1],
      [x + (s >> 1), y + (s >> 1)],
    ]
    for (const [px, py] of pts) {
      if (px >= W || py >= H) continue
      if (!near((py * W + px) * 4)) return true
    }
    return false
  }
  const excluded = (x, y) => excludes.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
  let s = Math.max(2, Math.round(3 * (W / img.cssWidth)))
  for (;;) {
    const list = []
    for (let y = 0; y < H; y += s) {
      for (let x = 0; x < W; x += s) {
        if (!excluded(x, y) && isContent(x, y, s)) list.push({ x, y })
      }
    }
    if (list.length <= MAX_PARTICLES || s >= 12) return { list, s }
    s += 1
  }
}

export function createPageTurn({ api, paperEl, sheetEl, contentEl, getExcludes }) {
  let seq = 0
  let cur = null // 正在播放的一段：{ canvas, raf, anims }
  const stats = { runs: 0, last: null }

  function finish() {
    if (!cur) return
    cancelAnimationFrame(cur.raf)
    cur.canvas?.remove()
    cur.anims.forEach((a) => {
      try {
        a.finish()
      } catch {}
    })
    cur = null
  }

  // 返回动画列表：位移用 --glide（快起长尾），透明度用慢起慢收，两者分开控制
  function slideIn(dir, delay = SLIDE_DELAY) {
    if (reducedMotion()) {
      return [contentEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' })]
    }
    return [
      contentEl.animate([{ transform: `translateX(${SLIDE_DIST * dir}px)` }, { transform: 'translateX(0)' }], {
        duration: SLIDE_DUR,
        delay,
        easing: GLIDE,
        fill: 'backwards',
      }),
      contentEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLIDE_DUR, delay, easing: FADE, fill: 'backwards' }),
    ]
  }

  // dir：1 = 往后翻（新页从右侧进入、旧页向左飘散），-1 = 往前翻，0 = 不播放
  async function run(dir, load) {
    const my = ++seq
    finish()
    if (!dir) return load()
    const info = { dir, t0: performance.now(), particles: 0, captureMs: null, startMs: null, frames: 0, fps: null, reduced: reducedMotion() }
    stats.runs++
    stats.last = info
    if (info.reduced) {
      await load()
      cur = { anims: slideIn(dir), canvas: null, raf: 0 }
      return
    }
    // 截取正文的可见区域（不含滚动条）
    const pr = paperEl.getBoundingClientRect()
    const sr = sheetEl.getBoundingClientRect()
    const rect = { x: pr.left, y: pr.top, width: paperEl.clientWidth, height: paperEl.clientHeight }
    let img = null
    try {
      img = await api.captureRect(rect)
    } catch {}
    info.captureMs = Math.round(performance.now() - info.t0)
    if (my !== seq) return load() // 期间又翻了一页：直接换内容，交给最新的那一次播放
    let canvas = null
    let particles = null
    let src = null
    if (img && img.data) {
      // BGRA → RGBA
      const px = new Uint8ClampedArray(img.data.buffer ? img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength) : img.data)
      for (let i = 0; i < px.length; i += 4) {
        const b = px[i]
        px[i] = px[i + 2]
        px[i + 2] = b
        px[i + 3] = 255
      }
      src = document.createElement('canvas')
      src.width = img.width
      src.height = img.height
      src.getContext('2d').putImageData(new ImageData(px, img.width, img.height), 0, 0)
      // 定格画面：画布盖在正文上（格式栏、翻页卡片在画布之上，不受影响）
      canvas = document.createElement('canvas')
      canvas.className = 'page-turn-canvas'
      canvas.width = img.width
      canvas.height = img.height
      Object.assign(canvas.style, {
        left: `${pr.left - sr.left}px`,
        top: `${pr.top - sr.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      })
      canvas.getContext('2d').drawImage(src, 0, 0)
      sheetEl.appendChild(canvas)
      const k = img.width / rect.width
      const excludes = (getExcludes?.() || []).map((r) => ({
        x: Math.floor((r.left - pr.left) * k),
        y: Math.floor((r.top - pr.top) * k),
        w: Math.ceil(r.width * k),
        h: Math.ceil(r.height * k),
      }))
      const bg = parseRgb(getComputedStyle(sheetEl).backgroundColor)
      particles = buildParticles({ ...img, data: px, cssWidth: rect.width }, bg, excludes)
      info.particles = particles.list.length
      info.k = k
    }
    contentEl.style.opacity = '0' // 新内容先藏起来，等滑入
    try {
      await load()
    } finally {
      contentEl.style.opacity = ''
    }
    const anims = slideIn(dir)
    cur = { canvas, raf: 0, anims }
    info.slideFrom = SLIDE_DIST * dir
    if (!canvas || !particles) return

    // 粒子：从离开的一侧开始逐列扫过，朝离开方向飘散并淡出
    const ctx = canvas.getContext('2d')
    const { list, s } = particles
    const W = canvas.width
    const k = info.k
    for (const p of list) {
      const across = dir > 0 ? p.x / W : 1 - p.x / W // 离开的一侧先散
      p.delay = across * SWEEP + Math.random() * JITTER
      p.vx = -dir * (40 + Math.random() * 100) * k
      p.vy = -(6 + Math.random() * 34) * k
      p.drift = (Math.random() - 0.5) * 16 * k
    }
    const total = SWEEP + JITTER + LIFE
    const start = performance.now()
    info.startMs = Math.round(start - info.t0)
    const frame = (now) => {
      if (!cur || cur.canvas !== canvas) return
      const t = now - start
      info.frames++
      ctx.clearRect(0, 0, W, canvas.height)
      for (const p of list) {
        const lt = t - p.delay
        if (lt <= 0) {
          ctx.globalAlpha = 1
          ctx.drawImage(src, p.x, p.y, s, s, p.x, p.y, s, s)
          continue
        }
        const q = lt / LIFE
        if (q >= 1) continue
        const e = 1 - (1 - q) * (1 - q) // 先快后慢
        ctx.globalAlpha = 1 - q * q
        const size = s * (1 - 0.35 * q)
        ctx.drawImage(src, p.x, p.y, s, s, p.x + p.vx * e + p.drift * q, p.y + p.vy * e, size, size)
      }
      if (t < total) cur.raf = requestAnimationFrame(frame)
      else {
        info.fps = Math.round((info.frames * 1000) / t)
        canvas.remove()
        if (cur && cur.canvas === canvas) cur.canvas = null
      }
    }
    cur.raf = requestAnimationFrame(frame)
  }

  return { run, finish, stats, busy: () => !!(cur && cur.canvas) }
}
