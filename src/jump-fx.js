// 设置里可选的新动效（设计规范 §6.6c）：卷纸翻书、墨迹晕散、风吹纸页、轻盈淡入。
// 翻页和文中链接跳转共用：翻页按方向播放，链接没有方向，按「往后翻」播放。
// 做法和 §6.6 一致：先截取正文的可见像素铺在画布上定格旧页，新页在画布下面换好，
// 再按各自的编排让旧页消失；截图失败时退回到只淡入新页。
import { reducedMotion } from './page-turn.js'

const FADE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const FADE_MS = 360
const CURL_MS = 780
const INK_MS = 860
const WIND_MS = 900

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
const easeOut = (t) => 1 - Math.pow(1 - t, 3)

// 墨迹用的软边圆点：只画一次，之后反复缩放贴上去
let blob = null
function blobSprite() {
  if (blob) return blob
  blob = document.createElement('canvas')
  blob.width = blob.height = 64
  const g = blob.getContext('2d')
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grd.addColorStop(0, 'rgba(0,0,0,1)')
  grd.addColorStop(0.62, 'rgba(0,0,0,0.96)')
  grd.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 64, 64)
  return blob
}

export function createJumpFx({ api, paperEl, sheetEl, contentEl, getExcludes }) {
  let seq = 0
  let cur = null // { canvas, raf, anims }
  const stats = { runs: 0, last: null }

  const resetContent = () => {
    contentEl.style.opacity = ''
    contentEl.style.transform = ''
  }

  function finish() {
    if (!cur) return
    cancelAnimationFrame(cur.raf)
    cur.canvas?.remove()
    cur.anims.forEach((a) => {
      try {
        a.finish()
      } catch {}
    })
    resetContent()
    cur = null
  }

  // 截图并铺成定格旧页的画布；失败返回 null
  async function captureOld(info) {
    const pr = paperEl.getBoundingClientRect()
    const sr = sheetEl.getBoundingClientRect()
    const rect = { x: pr.left, y: pr.top, width: paperEl.clientWidth, height: paperEl.clientHeight }
    let img = null
    try {
      img = await api.captureRect(rect)
    } catch {}
    info.captureMs = Math.round(performance.now() - info.t0)
    if (!img || !img.data) return null
    const raw = img.data
    const px = new Uint8ClampedArray(raw.buffer ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw)
    for (let i = 0; i < px.length; i += 4) {
      const b = px[i] // BGRA → RGBA
      px[i] = px[i + 2]
      px[i + 2] = b
      px[i + 3] = 255
    }
    const src = document.createElement('canvas')
    src.width = img.width
    src.height = img.height
    const sctx = src.getContext('2d')
    sctx.putImageData(new ImageData(px, img.width, img.height), 0, 0)
    // 格式栏、翻页卡片不参与动效：从定格画面里挖掉，露出下面本来就固定在那里的它们
    const k = img.width / rect.width
    for (const ex of getExcludes?.() || []) {
      sctx.clearRect((ex.left - pr.left) * k, (ex.top - pr.top) * k, ex.width * k, ex.height * k)
    }
    const canvas = document.createElement('canvas')
    canvas.className = 'page-turn-canvas'
    canvas.width = img.width
    canvas.height = img.height
    Object.assign(canvas.style, {
      left: `${pr.left - sr.left}px`,
      top: `${pr.top - sr.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    })
    const ctx = canvas.getContext('2d')
    ctx.drawImage(src, 0, 0)
    sheetEl.appendChild(canvas)
    return { canvas, ctx, src, W: img.width, H: img.height, cssWidth: rect.width }
  }

  function animate(cap, info, my, dur, draw) {
    const { canvas, ctx } = cap
    cur = { canvas, raf: 0, anims: [] }
    const start = performance.now()
    info.startMs = Math.round(start - info.t0)
    const frame = (now) => {
      if (my !== seq || !cur || cur.canvas !== canvas) return
      info.frames++
      const p = clamp01((now - start) / dur)
      draw(ctx, p)
      if (p < 1) cur.raf = requestAnimationFrame(frame)
      else {
        info.fps = Math.round((info.frames * 1000) / Math.max(1, now - start))
        canvas.remove()
        if (cur && cur.canvas === canvas) cur = null
      }
    }
    cur.raf = requestAnimationFrame(frame)
  }

  // 轻盈淡入：不截旧页，直接让新页浮现
  async function runFade(load, info, my) {
    const dur = info.reduced ? 150 : FADE_MS
    contentEl.style.opacity = '0'
    await load()
    if (my !== seq) {
      resetContent()
      return
    }
    resetContent()
    info.startMs = Math.round(performance.now() - info.t0)
    const anim = contentEl.animate(
      info.reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: 'translateY(10px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
      { duration: dur, easing: FADE_EASE }
    )
    cur = { canvas: null, raf: 0, anims: [anim] }
    anim.finished
      .then(() => {
        if (my !== seq) return
        resetContent()
        if (cur && cur.anims.includes(anim)) cur = null
      })
      .catch(() => {})
  }

  // 卷纸翻书：旧页从翻页方向的对侧卷起，折痕带暗边，并在新页上落下阴影
  function playCurl(cap, info, my, dir) {
    const { W, H, cssWidth, src } = cap
    const k = W / cssWidth
    // 折痕和影子都要很轻：带子别太宽、压暗和投影都克制，不能抢正文的注意力
    const band = Math.max(10 * k, W * 0.032)
    const dark = document.documentElement.dataset.theme === 'dark'
    const foldShade = dark ? 'rgba(0,0,0,0.26)' : 'rgba(0,0,0,0.08)'
    const castShadow = dark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.07)'
    const edge = dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.35)'
    animate(cap, info, my, CURL_MS, (ctx, p) => {
      const e = easeInOut(p)
      const fold = W * (dir > 0 ? 1 - e : e)
      ctx.clearRect(0, 0, W, H)
      // 留白的宽度可能接近 0（刚起手）或整页（结束）：只有真正有旧页可画时才绘制，
      // 否则往前翻的首帧会把整页清空、闪一下新页（AC-N44）
      const vis = dir > 0 ? fold : W - fold
      if (vis > 0.5) {
        if (dir > 0) ctx.drawImage(src, 0, 0, fold, H, 0, 0, fold, H)
        else ctx.drawImage(src, fold, 0, W - fold, H, fold, 0, W - fold, H)
      }
      const b = Math.min(band, fold)
      if (b > 1) {
        // 折痕内侧压暗，外侧在新页上落一层柔和的影子
        if (dir > 0) {
          const inside = ctx.createLinearGradient(fold - b, 0, fold, 0)
          inside.addColorStop(0, 'rgba(0,0,0,0)')
          inside.addColorStop(0.8, foldShade)
          inside.addColorStop(1, foldShade)
          ctx.fillStyle = inside
          ctx.fillRect(fold - b, 0, b, H)
          const cast = ctx.createLinearGradient(fold, 0, fold + b * 0.7, 0)
          cast.addColorStop(0, castShadow)
          cast.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.fillStyle = cast
          ctx.fillRect(fold, 0, b * 0.7, H)
        } else {
          const inside = ctx.createLinearGradient(fold + b, 0, fold, 0)
          inside.addColorStop(0, 'rgba(0,0,0,0)')
          inside.addColorStop(0.8, foldShade)
          inside.addColorStop(1, foldShade)
          ctx.fillStyle = inside
          ctx.fillRect(fold, 0, b, H)
          const cast = ctx.createLinearGradient(fold, 0, fold - b * 0.7, 0)
          cast.addColorStop(0, castShadow)
          cast.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.fillStyle = cast
          ctx.fillRect(fold - b * 0.7, 0, b * 0.7, H)
        }
        // 纸的翻边
        ctx.fillStyle = edge
        ctx.fillRect(fold - Math.max(1, k), 0, Math.max(1, k), H)
      }
    })
  }

  // 墨迹晕散：旧页从若干点化开，沿翻页方向连成片消失
  function playInk(cap, info, my, dir) {
    const { W, H, src } = cap
    const sprite = blobSprite()
    const cols = 10
    const rows = 12
    const cell = W / cols
    const seeds = []
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const x = ((gx + 0.1 + Math.random() * 0.8) / cols) * W
        const y = ((gy + 0.1 + Math.random() * 0.8) / rows) * H
        const order = dir > 0 ? x / W : 1 - x / W
        seeds.push({
          x,
          y,
          r: cell * (0.5 + Math.random() * 0.5),
          delay: order * 0.34 + Math.random() * 0.1,
          dur: 0.44 + Math.random() * 0.18,
          ox: Math.random() - 0.5,
          oy: Math.random() - 0.5,
        })
      }
    }
    animate(cap, info, my, INK_MS, (ctx, p) => {
      if (p >= 0.999) {
        ctx.clearRect(0, 0, W, H)
        return
      }
      ctx.globalCompositeOperation = 'destination-out'
      for (const s of seeds) {
        const q = clamp01((p - s.delay) / s.dur)
        if (q <= 0) continue
        const r = s.r * easeOut(q)
        ctx.drawImage(sprite, s.x - r, s.y - r, r * 2, r * 2)
        const r2 = r * 0.58
        ctx.drawImage(sprite, s.x + s.ox * r - r2, s.y + s.oy * r - r2, r2 * 2, r2 * 2)
      }
      ctx.globalCompositeOperation = 'source-over'
    })
  }

  // 风吹纸页：旧页裂成竖条，先离翻页方向近的一侧被风吹走
  function playWind(cap, info, my, dir) {
    const { W, H, src, cssWidth } = cap
    const k = W / cssWidth
    const sw = Math.max(4, Math.round(8 * k))
    const strips = []
    for (let x = 0; x < W; x += sw) {
      const near = dir > 0 ? 1 - x / W : x / W
      strips.push({
        x,
        delay: near * 0.34 + Math.random() * 0.08,
        // 竖条被风带得足够远，离开纸面时基本已经出了正文区域
        dx: W * (0.3 + Math.random() * 0.45),
        dy: (40 + Math.random() * 160) * k,
        flut: (Math.random() - 0.5) * 44 * k,
      })
    }
    animate(cap, info, my, WIND_MS, (ctx, p) => {
      ctx.clearRect(0, 0, W, H)
      ctx.globalAlpha = 1
      for (const s of strips) {
        const q = clamp01((p - s.delay) / 0.55)
        if (q <= 0) {
          ctx.globalAlpha = 1
          ctx.drawImage(src, s.x, 0, sw, H, s.x, 0, sw, H)
          continue
        }
        const u = easeInOut(q)
        // 竖条先保持不透明地飘走，最后才快速淡出，避免半透明时新旧文字叠在一起
        ctx.globalAlpha = 1 - Math.pow(u, 16)
        ctx.drawImage(
          src,
          s.x,
          0,
          sw,
          H,
          s.x - dir * s.dx * u,
          -s.dy * u + s.flut * Math.sin(u * Math.PI * 1.5),
          sw + 1,
          H
        )
      }
      ctx.globalAlpha = 1
    })
  }

  // effect：curl | ink | wind | fade；kind：'turn' | 'link'；dir：1 往后、-1 往前、0 不播放
  async function run({ effect = 'fade', kind = 'turn', dir = 1, load }) {
    const my = ++seq
    finish()
    if (!dir) return load()
    const info = {
      effect,
      kind,
      dir,
      t0: performance.now(),
      captureMs: null,
      startMs: null,
      frames: 0,
      fps: null,
      reduced: reducedMotion(),
    }
    stats.runs++
    stats.last = info
    if (info.reduced || effect === 'fade') return runFade(load, info, my)
    const cap = await captureOld(info)
    if (my !== seq) return load()
    if (!cap) return runFade(load, info, my)
    await load()
    if (my !== seq) {
      cap.canvas.remove()
      return
    }
    if (effect === 'curl') playCurl(cap, info, my, dir)
    else if (effect === 'ink') playInk(cap, info, my, dir)
    else playWind(cap, info, my, dir)
  }

  return { run, finish, stats, busy: () => !!(cur && cur.canvas) }
}