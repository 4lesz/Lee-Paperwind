// 生成应用图标（设计规范 §3.5b）：npx electron scripts/make-icon.cjs
// 输出 build/icon.svg（大尺寸母版）、build/icon-small.svg（≤32px 用的精简版）、
// build/icons/<尺寸>.png、build/icon.ico（安装包、exe、.md 文件关联用）、build/icon.png（256，窗口用）
// 只开一个隐藏窗口在画布上渲染，不发送按键，可以在产品负责人使用电脑时运行。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'build')
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

// 固定种子的随机数，保证每次生成的粒子位置相同
function rnd(s) { return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 } }
const f = (n) => +n.toFixed(2)

// 笔的几何（未旋转时笔尖朝左、水平放置，最后整体旋转 -45°）
const W = 18, Y0 = 41, Y1 = 59, TIP = 14, CONE = 33, CUT = 56

function outline(stroke) {
  return `<path d="M${TIP} 50 L${CONE} ${Y0} H${CUT} M${CUT} ${Y1} H${CONE} L${TIP} 50 M${CONE} ${Y0} V${Y1}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M${TIP} 50 L20 46.8 V53.2 Z" fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`
}

function particles(small, op) {
  const r = rnd(6), n = small ? 3 : 4, c = W / n, end = CUT + (small ? 22 : 32)
  let s = ''
  for (let x = CUT; x < end; x += c) {
    for (let k = 0; k < n; k++) {
      const y = Y0 + k * c, t = (x - CUT) / (end - CUT)
      if (t > 0.08 && r() < t * 0.6) continue
      const sz = c * (0.9 - t * 0.45)
      const dx = t * t * 12 * (0.6 + r() * 0.8)
      const dy = -t * 10 * (0.3 + r()) + (r() - 0.5) * t * 5
      s += `<rect x="${f(x + dx + (c - sz) / 2)}" y="${f(y + dy + (c - sz) / 2)}" width="${f(sz)}" height="${f(sz)}" rx="${f(sz * 0.25)}" fill="#fff" opacity="${f(op * (1 - t * 0.6))}"/>`
    }
  }
  return s
}

function svg(small) {
  // 小尺寸：残影会把笔身内部糊满，所以只留一层更粗的线条（残影只在 ≥40px 出现）
  const stroke = small ? 5.5 : 3.2
  const copies = small ? [[0, 0, 0.95]] : [[0.6, 3, 0.25], [-0.6, -3, 0.25], [0, 0, 0.85]]
  const pencil = copies.map(([dx, dy, op]) => `<g opacity="${op}" transform="translate(${dx} ${dy})">${outline(stroke)}</g>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC93C"/><stop offset="1" stop-color="#FF8A00"/></linearGradient>
<linearGradient id="hi" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<rect x="4" y="4" width="92" height="92" rx="22" fill="url(#bg)"/>
<rect x="4" y="4" width="92" height="92" rx="22" fill="url(#hi)"/>
<g transform="rotate(-45 50 50) translate(-1 1)">${pencil}${particles(small, 0.7)}</g>
</svg>
`
}

// ICO：每个尺寸直接存 PNG（Windows Vista 起支持）
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4)
  let offset = head.length
  pngs.forEach(({ size, buf }, i) => {
    const o = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, o)
    head.writeUInt8(size >= 256 ? 0 : size, o + 1)
    head.writeUInt8(0, o + 2); head.writeUInt8(0, o + 3)
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6)
    head.writeUInt32LE(buf.length, o + 8); head.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  return Buffer.concat([head, ...pngs.map((p) => p.buf)])
}

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true })
  const big = svg(false), small = svg(true)
  fs.writeFileSync(path.join(OUT, 'icon.svg'), big)
  fs.writeFileSync(path.join(OUT, 'icon-small.svg'), small)

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<meta charset="utf-8"><body></body>')
  const render = (src, size) => win.webContents.executeJavaScript(`new Promise((ok, no) => {
    const img = new Image()
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size}
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${size}, ${size}); ok(c.toDataURL('image/png')) }
    img.onerror = () => no(new Error('svg 载入失败'))
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(src)})
  })`)

  const pngs = []
  for (const size of SIZES) {
    const url = await render(size <= 32 ? small : big, size)
    const buf = Buffer.from(url.split(',')[1], 'base64')
    fs.writeFileSync(path.join(OUT, 'icons', `${size}.png`), buf)
    pngs.push({ size, buf })
  }
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(pngs.filter((p) => [16, 20, 24, 32, 40, 48, 64, 256].includes(p.size))))
  fs.copyFileSync(path.join(OUT, 'icons', '256.png'), path.join(OUT, 'icon.png'))
  console.log('图标已生成：', SIZES.join('、'))
  app.quit()
}).catch((e) => { console.error(e); app.exit(1) })
