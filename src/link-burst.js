// 链接跳转动效（设计规范 §6.6b）：旧页的字先快速抖动，然后炸成粒子随风飘散；
// 新的一页由风送来的细粒子「落」成：粒子落到哪里，哪里的字就清楚地显出来。
//
// 做法：跳转前截取正文区域的真实像素（与翻页动效相同），切成约 3px 的小方块作为旧粒子；
// 新的一篇在画布下面换好（先隐藏），按新页可见区域里每个字的位置、字体、颜色在离屏画布上画出来（文字画布），
// 再按笔画取约 2px 的细粒子。粒子随风飘向落点，落下时在「显影遮罩」上留下一个柔和的圆点，
// 屏幕上显示的是「文字画布 × 遮罩」：落下的粒子越多，那里的字越完整，字本身始终是清晰的原样笔画（不模糊、不成方块）。
// 全部落定后补齐遮罩，再与真正的新页交叉淡换（两者几乎一模一样，看不出切换）。
import { reducedMotion, parseRgb, buildParticles, MAX_PARTICLES } from './page-turn.js'

const SHAKE = 320 // 抖动阶段
const SHAKE_AMP = 3 // 抖动的最大幅度（CSS 像素）
const CELL = 14 // 抖动按小格各自进行，大致一个字
const BURST_JITTER = 120 // 每颗粒子开始炸开的随机延迟
const FADE_LIFE = 800 // 炸开后完全淡出所用的时间
const WIND_X = 1300 // 风：向右的加速度（CSS 像素 / 秒²）
const WIND_Y = -260 // 略微向上

const FORM_AT = 650 // 新粒子开始飘来
const FORM_SWEEP = 320 // 风从左吹到右：左边的字先落成，右边的晚一些
const FORM_JITTER = 220 // 每颗另加的随机延迟
const FORM_DUR = [380, 620] // 每颗从出现到落下（快慢不一）
const FORM_FROM = [18, 68] // 从落点上风处（左侧）多远飘来（CSS 像素）
const FLUTTER = [5, 13] // 飘动的摆幅（CSS 像素），越靠近落点越小
const FORM_GRAIN = 2 // 新粒子的间距（CSS 像素）
const STAMP = 0.6 // 每颗粒子落下时在遮罩上留下的不透明度（几颗叠在一起就完整了）
const FILL_DUR = 160 // 全部落定后，补齐个别没落到的笔画边缘
const SWAP_DUR = 240 // 与真正的新页交叉淡换

// 柔和的圆点（中心实、边缘渐隐）
function dotSprite(color, d) {
  const c = document.createElement('canvas')
  c.width = c.height = d
  const g = c.getContext('2d')
  const r = d / 2
  const grad = g.createRadialGradient(r, r, 0, r, r, r)
  grad.addColorStop(0, color)
  grad.addColorStop(0.45, color)
  grad.addColorStop(1, color.replace('rgb(', 'rgba(').replace(')', ',0)'))
  g.fillStyle = grad
  g.fillRect(0, 0, d, d)
  return c
}

export function createLinkBurst({ api, paperEl, sheetEl, contentEl, getExcludes, isSettled }) {
  let seq = 0
  let cur = null // { canvas, raf, anims }
  const stats = { runs: 0, last: null }

  function finish() {
    if (!cur) return
    cancelAnimationFrame(cur.raf)
    cur.canvas?.remove()
    contentEl.style.opacity = ''
    cur.anims?.forEach((a) => {
      try {
        a.finish()
      } catch {}
    })
    cur = null
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()))

  // 新页可见区域的文字 → 文字画布 + 细粒子（设备像素坐标、颜色、覆盖程度）
  function buildTargets(rect, k, W, H, excludes) {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const g = c.getContext('2d', { willReadFrequently: true })
    g.setTransform(k, 0, 0, k, 0, 0)
    g.textBaseline = 'alphabetic'
    const top = rect.y
    const bottom = rect.y + rect.height
    const left = rect.x
    const right = rect.x + rect.width
    const range = document.createRange()
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT)
    const styles = new Map()
    let n
    while ((n = walker.nextNode())) {
      const el = n.parentElement
      if (!el) continue
      const er = el.getBoundingClientRect()
      if (er.bottom < top || er.top > bottom || er.width === 0) continue
      let st = styles.get(el)
      if (!st) {
        const cs = getComputedStyle(el)
        st = { font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, color: cs.color, hidden: cs.visibility === 'hidden' }
        g.font = st.font
        // 字的外框高度就是字体的上沿 + 下沿，基线在上沿处：与页面上的字逐像素对齐
        st.ascent = g.measureText('字').fontBoundingBoxAscent
        styles.set(el, st)
      }
      if (st.hidden) continue
      g.font = st.font
      g.fillStyle = st.color
      const t = n.data
      for (let i = 0; i < t.length; i++) {
        const code = t.charCodeAt(i)
        const len = code >= 0xd800 && code <= 0xdbff ? 2 : 1
        const ch = t.substr(i, len)
        const at = i
        i += len - 1
        if (!ch.trim()) continue
        range.setStart(n, at)
        range.setEnd(n, at + len)
        const r = range.getClientRects()[0]
        if (!r || r.bottom < top || r.top > bottom || r.right < left || r.left > right) continue
        g.fillText(ch, r.left - left, r.top - top + st.ascent)
      }
    }
    // 只取文字（图片、代码块底色等在最后交叉淡换时出现）
    const data = g.getImageData(0, 0, W, H).data
    const excluded = (x, y) => excludes.some((e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h)
    let s = Math.max(1, Math.round(FORM_GRAIN * k))
    for (;;) {
      const list = []
      for (let y = 0; y < H; y += s) {
        for (let x = 0; x < W; x += s) {
          if (excluded(x, y)) continue
          let sum = 0
          let best = -1
          let cnt = 0
          for (let yy = y; yy < Math.min(H, y + s); yy++) {
            for (let xx = x; xx < Math.min(W, x + s); xx++) {
              const i = (yy * W + xx) * 4
              const a = data[i + 3]
              sum += a
              cnt++
              if (a > (best >= 0 ? data[best + 3] : 0)) best = i
            }
          }
          const cov = sum / cnt / 255
          if (cov < 0.08 || best < 0) continue
          list.push({ x, y, cov: Math.min(1, cov), color: `rgb(${data[best]},${data[best + 1]},${data[best + 2]})` })
        }
      }
      if (list.length <= MAX_PARTICLES * 1.5 || s >= 8) return { list, s, text: c }
      s += 1
    }
  }

  async function run(load) {
    const my = ++seq
    finish()
    const info = { kind: 'burst', t0: performance.now(), particles: 0, targets: 0, captureMs: null, startMs: null, targetsMs: null, frames: 0, fps: null, phases: {}, reduced: reducedMotion(), endMs: null }
    stats.runs++
    stats.last = info
    const fadeIn = (duration) => [contentEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease-out' })]
    if (info.reduced) {
      await load()
      cur = { anims: fadeIn(150), canvas: null, raf: 0 }
      return
    }
    const pr = paperEl.getBoundingClientRect()
    const sr = sheetEl.getBoundingClientRect()
    const rect = { x: pr.left, y: pr.top, width: paperEl.clientWidth, height: paperEl.clientHeight }
    let img = null
    try {
      img = await api.captureRect(rect)
    } catch {}
    info.captureMs = Math.round(performance.now() - info.t0)
    if (my !== seq) return load()
    if (!img || !img.data) {
      await load()
      cur = { anims: fadeIn(220), canvas: null, raf: 0 }
      return
    }
    // 截图（BGRA → RGBA）作为旧粒子的来源
    const px = new Uint8ClampedArray(img.data.buffer ? img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength) : img.data)
    for (let i = 0; i < px.length; i += 4) {
      const b = px[i]
      px[i] = px[i + 2]
      px[i + 2] = b
      px[i + 3] = 255
    }
    const src = document.createElement('canvas')
    src.width = img.width
    src.height = img.height
    src.getContext('2d').putImageData(new ImageData(px, img.width, img.height), 0, 0)
    const canvas = document.createElement('canvas')
    canvas.className = 'page-turn-canvas link-burst-canvas'
    canvas.width = img.width
    canvas.height = img.height
    Object.assign(canvas.style, { left: `${pr.left - sr.left}px`, top: `${pr.top - sr.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    const ctx = canvas.getContext('2d')
    ctx.drawImage(src, 0, 0)
    sheetEl.appendChild(canvas)
    const W = canvas.width
    const H = canvas.height
    const k = img.width / rect.width
    const excludes = (getExcludes?.() || []).map((r) => ({
      x: Math.floor((r.left - pr.left) * k),
      y: Math.floor((r.top - pr.top) * k),
      w: Math.ceil(r.width * k),
      h: Math.ceil(r.height * k),
    }))
    const bg = parseRgb(getComputedStyle(sheetEl).backgroundColor)
    const { list: olds, s } = buildParticles({ ...img, data: px, cssWidth: rect.width }, bg, excludes)
    info.particles = olds.length

    // 旧粒子：所在小格、炸开的时间和方向、被风吹动的程度
    const cellPx = CELL * k
    const cols = Math.ceil(W / cellPx) + 1
    const rows = Math.ceil(H / cellPx) + 1
    const shake = new Float32Array(cols * rows * 2)
    for (const p of olds) {
      p.cell = (Math.floor(p.y / cellPx) * cols + Math.floor(p.x / cellPx)) * 2
      p.t0 = SHAKE + Math.random() * BURST_JITTER
      const a = Math.random() * Math.PI * 2
      const v = (150 + Math.random() * 370) * k
      p.vx = Math.cos(a) * v
      p.vy = Math.sin(a) * v
      p.wind = 0.6 + Math.random() * 0.8
      p.phase = Math.random() * Math.PI * 2
    }

    contentEl.style.opacity = '0' // 新页先藏起来，由粒子落成
    // 新页：文字画布、显影遮罩（粒子落下处留下的圆点）、合成结果
    let form = null // { targets, groups, text, mask, mctx, comp, cctx, ts, D, sprites, maskDot, base }
    const start = performance.now()
    info.startMs = Math.round(start - info.t0)
    cur = { canvas, raf: 0, anims: [] }

    const frame = (now) => {
      if (!cur || cur.canvas !== canvas) return
      const t = Math.max(0, now - start)
      info.frames++
      ctx.clearRect(0, 0, W, H)
      ctx.globalAlpha = 1
      // 旧页：抖动（每个小格一个随机偏移，幅度逐渐加大），然后炸开、随风飘散并淡出
      const amp = SHAKE_AMP * k * Math.pow(Math.min(1, t / SHAKE), 1.5)
      for (let i = 0; i < shake.length; i++) shake[i] = (Math.random() * 2 - 1) * amp
      if (t < SHAKE) info.phases.shake ??= Math.round(t)
      for (const p of olds) {
        if (t < p.t0) {
          ctx.globalAlpha = 1
          ctx.drawImage(src, p.x, p.y, s, s, p.x + shake[p.cell], p.y + shake[p.cell + 1], s, s)
          continue
        }
        info.phases.explode ??= Math.round(t)
        const q = (t - p.t0) / FADE_LIFE
        if (q >= 1) continue
        const lt = (t - p.t0) / 1000
        const burst = (1 - Math.exp(-lt * 6)) / 6 // 迸开后很快减速
        const x = p.x + p.vx * burst + 0.5 * WIND_X * k * p.wind * lt * lt
        const y = p.y + p.vy * burst + 0.5 * WIND_Y * k * p.wind * lt * lt + Math.sin(lt * 7 + p.phase) * 10 * k * lt
        ctx.globalAlpha = (1 - q) * (1 - q)
        const size = s * (1 - 0.4 * q)
        ctx.drawImage(src, p.x, p.y, s, s, x, y, size, size)
      }
      if (form) {
        const f = form
        // 1) 飘动中的粒子；落下的那一刻在遮罩上留下圆点
        let flying = false
        const sec = t / 1000
        for (const [color, idx] of f.groups) {
          const dot = f.sprites.get(color)
          for (const i of idx) {
            const g = f.targets[i]
            if (g.landed) continue
            const ta = f.base + g.delay
            if (t < ta) {
              flying = true
              continue
            }
            info.phases.form ??= Math.round(t)
            const q = (t - ta) / g.dur
            if (q >= 1) {
              g.landed = true
              f.mctx.globalAlpha = STAMP
              f.mctx.drawImage(f.maskDot, g.x + f.ts / 2 - f.D / 2, g.y + f.ts / 2 - f.D / 2, f.D, f.D)
              continue
            }
            flying = true
            // 被风吹着飘来：从上风处顺风而来，风渐渐停下（减速），路上随风摆动，越靠近落点越平稳
            const e = 1 - (1 - q) * (1 - q)
            const loose = 1 - e
            const gust = Math.sin(sec * 2.3 + g.y * 0.004) * 6 * k
            const fx = (Math.sin(sec * g.wf + g.wp) * g.wa + gust) * loose
            const fy = Math.cos(sec * g.wf * 1.3 + g.wp) * g.wa * 0.8 * loose
            ctx.globalAlpha = g.cov * 0.55 * Math.min(1, q * 4)
            const size = f.Dfly * (0.8 + 0.2 * e)
            ctx.drawImage(dot, g.x + f.ts / 2 + g.dx * loose + fx - size / 2, g.y + f.ts / 2 + g.dy * loose + fy - size / 2, size, size)
          }
        }
        // 2) 落下的地方显出清晰的字：文字画布 × 遮罩
        if (!flying && f.settleAt === undefined) {
          f.settleAt = t
          info.phases.settle = Math.round(t)
        }
        if (f.settleAt !== undefined) {
          // 全部落定：把遮罩补满（个别没有粒子落到的笔画边缘）
          f.mctx.globalAlpha = Math.min(1, (t - f.settleAt) / FILL_DUR) * 0.5
          f.mctx.fillRect(0, 0, W, H)
        }
        f.cctx.globalCompositeOperation = 'copy'
        f.cctx.globalAlpha = 1
        f.cctx.drawImage(f.mask, 0, 0)
        f.cctx.globalCompositeOperation = 'source-in'
        f.cctx.drawImage(f.text, 0, 0)
        ctx.globalAlpha = 1
        ctx.drawImage(f.comp, 0, 0)
        // 3) 与真正的新页交叉淡换
        if (f.settleAt !== undefined && t - f.settleAt >= FILL_DUR && !f.swapAt) {
          f.swapAt = t
          info.phases.reveal = Math.round(t)
          contentEl.style.opacity = ''
          cur.anims = [contentEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SWAP_DUR, easing: 'ease-in-out' })]
          canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SWAP_DUR, easing: 'ease-in-out', fill: 'forwards' })
        }
        if (f.swapAt && t - f.swapAt >= SWAP_DUR) {
          info.fps = Math.round((info.frames * 1000) / t)
          info.endMs = Math.round(now - info.t0)
          canvas.remove()
          cur.canvas = null
          return
        }
      }
      cur.raf = requestAnimationFrame(frame)
    }
    cur.raf = requestAnimationFrame(frame)

    // 换成新的一篇（隐藏着），等它定位好后按文字生成新粒子
    try {
      await load()
    } catch (e) {
      finish()
      throw e
    }
    for (let i = 0; i < 30 && isSettled && !isSettled(); i++) await nextFrame()
    await nextFrame()
    if (my !== seq || !cur || cur.canvas !== canvas) return
    const built = buildTargets(rect, k, W, H, excludes)
    const targets = built.list
    info.targets = targets.length
    info.targetsMs = Math.round(performance.now() - start)
    const ts = built.s
    const D = Math.max(4, Math.round(ts * 2.6))
    const mask = document.createElement('canvas')
    mask.width = W
    mask.height = H
    const comp = document.createElement('canvas')
    comp.width = W
    comp.height = H
    const groups = new Map()
    targets.forEach((g, i) => {
      // 从上风处（左侧、略偏下，与旧页粒子被吹走的方向一致）飘来；左边的先到，每颗的距离、快慢、摆动各不相同
      g.dx = -(FORM_FROM[0] + Math.random() * (FORM_FROM[1] - FORM_FROM[0])) * k
      g.dy = (6 + (Math.random() - 0.5) * 36) * k
      g.wa = (FLUTTER[0] + Math.random() * (FLUTTER[1] - FLUTTER[0])) * k
      g.wf = 4 + Math.random() * 5
      g.wp = Math.random() * Math.PI * 2
      g.dur = FORM_DUR[0] + Math.random() * (FORM_DUR[1] - FORM_DUR[0])
      g.delay = (g.x / W) * FORM_SWEEP + Math.random() * FORM_JITTER
      if (!groups.has(g.color)) groups.set(g.color, [])
      groups.get(g.color).push(i)
    })
    const sprites = new Map()
    for (const color of groups.keys()) sprites.set(color, dotSprite(color, Math.max(3, Math.round(ts * 1.7))))
    form = {
      targets,
      groups,
      text: built.text,
      mask,
      mctx: mask.getContext('2d'),
      comp,
      cctx: comp.getContext('2d'),
      ts,
      D,
      Dfly: Math.max(3, Math.round(ts * 1.7)), // 飘动中的粒子更细，只是一粒粒的光点
      sprites,
      maskDot: dotSprite('rgb(255,255,255)', D),
      base: Math.max(FORM_AT, performance.now() - start),
    }
  }

  return { run, finish, stats, busy: () => !!(cur && cur.canvas) }
}
