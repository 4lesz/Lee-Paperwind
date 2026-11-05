// 截取真实窗口画面（含系统半透明材质），用于视觉验收
// 用法：npx electron scripts/screenshot.cjs <样本.md> <输出目录>
const { app, desktopCapturer, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const outDir = path.resolve(process.argv[process.argv.length - 1])
fs.mkdirSync(outDir, { recursive: true })
app.setPath('userData', path.join(outDir, 'userdata-shot'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

require('../electron/main.cjs')

let started = false
app.on('browser-window-created', (_e, win) => {
  if (started) return
  started = true
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`)
    // 截屏得到的是屏幕上这块区域的样子：若有别的窗口盖在程序上面，会把别的窗口拍进来。
    // 所以每次都与程序自己画出的画面（capturePage，只含本程序）比对正文区域，不一致就重拍；
    // 三次仍不一致时只保存程序自己画出的画面（没有半透明材质，但绝不会拍到别的程序）。
    const sameAsApp = (screenImg, appImg) => {
      const w = 240
      const a = screenImg.resize({ width: w })
      const c = appImg.resize({ width: w, height: a.getSize().height })
      const { height: h } = a.getSize()
      const A = a.toBitmap()
      const C = c.toBitmap()
      let sum = 0
      let n = 0
      // 只比正文纸面（右侧 70%、标题栏以下）：标题栏和侧栏是半透明材质，两种截法本来就不同
      for (let y = Math.round(h * 0.15); y < h; y += 2) {
        for (let x = Math.round(w * 0.3); x < w; x += 2) {
          const i = (y * w + x) * 4
          sum += Math.abs(A[i] - C[i]) + Math.abs(A[i + 1] - C[i + 1]) + Math.abs(A[i + 2] - C[i + 2])
          n += 3
        }
      }
      return sum / n < 18
    }
    const grab = async (name, ensure = null) => {
      console.log('截图', name)
      for (let attempt = 0; attempt < 3; attempt++) {
        if (ensure) await js(ensure) // 每次拍之前确认要拍的状态还在（例如弹窗没有被意外关掉）
        if (win.isMinimized()) win.restore()
        win.show()
        win.setAlwaysOnTop(true, 'screen-saver')
        win.moveTop()
        win.focus()
        await wait(700)
        const b = win.getBounds()
        const d = screen.getDisplayMatching(b)
        const sf = d.scaleFactor
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) },
        })
        const src = sources.find((s) => s.display_id === String(d.id)) || sources[0]
        const img = src.thumbnail.crop({
          x: Math.round((b.x - d.bounds.x) * sf),
          y: Math.round((b.y - d.bounds.y) * sf),
          width: Math.round(b.width * sf),
          height: Math.round(b.height * sf),
        })
        const own = await win.webContents.capturePage()
        if (sameAsApp(img, own)) {
          fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG())
          return
        }
        console.log('  有别的窗口挡住，重拍', name)
      }
      console.log('  改存程序自身画面', name)
      fs.writeFileSync(path.join(outDir, name + '.png'), (await win.webContents.capturePage()).toPNG())
      skipped.push(name)
    }
    const skipped = []
    const compat = fs.readFileSync(path.join(__dirname, '..', 'samples', '兼容性.md'), 'utf8')
    const sample = fs.readFileSync(path.resolve(process.argv.find((a) => a.endsWith('.md'))), 'utf8')
    const setTheme = (t) => js(`window.__keepPopoverOnBlur = true; document.documentElement.dataset.theme = '${t}'; window.api.setTheme('${t}')`)
    const selectText = (t) =>
      js(`const e = window.__editor; let pos = null
        e.state.doc.descendants((n, p) => { if (pos === null && n.isText && n.text.includes('${t}')) pos = p + n.text.indexOf('${t}') })
        e.chain().focus().setTextSelection({ from: pos, to: pos + ${t.length} }).run()`)
    const click = (sel) => js(`const b = document.querySelector('${sel}'); b.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); b.click()`)
    const scroll = (y) => js(`document.getElementById('paper').scrollTop = ${y}`)
    try {
      win.setAlwaysOnTop(true)
      await wait(1800)
      for (const theme of ['light', 'dark']) {
        const tag = theme === 'light' ? '浅色' : '深色'
        await setTheme(theme)
        await js(`window.__test.loadDoc({ path: ${JSON.stringify(path.resolve('samples/示例.md'))}, name: '示例.md', content: ${JSON.stringify(sample)} })`)
        await wait(600)
        await grab(`${tag}-1-编辑`)
        await selectText('普通文字')
        await wait(500)
        await grab(`${tag}-2-浮动菜单`)
        await js(`window.__editor.commands.setTextSelection(2)`)
        await click('#toolbar [data-cmd=style]')
        await wait(500)
        await grab(`${tag}-3-Aa面板`)
        await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await scroll(560)
        await js(`const p = [...document.querySelectorAll('.prose pre')][0]; window.__editor.commands.setTextSelection(window.__editor.view.posAtDOM(p, 0) + 1)`)
        await wait(300)
        await click('#toolbar .context .pill')
        await wait(500)
        await grab(`${tag}-4-代码语言`)
        await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await selectText('好的工具')
        await click('#toolbar [data-cmd=link]')
        await wait(500)
        await grab(`${tag}-5-链接弹窗`)
        await js(`document.querySelector('.modal [data-act=cancel]').click()`)
        await wait(300)
        await click('.titlebar [data-cmd=source]')
        await wait(500)
        await grab(`${tag}-6-源码模式`)
        await click('.titlebar [data-cmd=source]')
        await click('.mode-switch .seg-item[data-value=read]')
        await scroll(0)
        await wait(500)
        await grab(`${tag}-7-阅读模式`)
        await click('.mode-switch .seg-item[data-value=edit]')
        await js(`window.__test.loadDoc({ path: null, name: '兼容性.md', content: ${JSON.stringify(compat)} })`)
        await wait(600)
        await grab(`${tag}-8-HTML保留`)
        // M2.5：篇目、上一篇/下一篇、编辑/阅读滑块
        await js(`await window.__test.openFolder(${JSON.stringify(path.resolve('samples/连载'))})`)
        await wait(600)
        await js(`await window.__test.gotoFile(${JSON.stringify(path.resolve('samples/连载/02-第二章.md'))}); document.getElementById('paper').scrollTop = 0`)
        await wait(600)
        await grab(`${tag}-9-篇目`)
        await js(`document.querySelector('#filesList .folder-item[title="第一卷"]')?.click()`)
        await wait(400)
        await grab(`${tag}-9b-子文件夹展开`)
        await js(`document.querySelector('#filesList .folder-item[title="第一卷"]')?.click()`)
        await scroll(100000)
        await wait(400)
        await grab(`${tag}-10-上一篇下一篇`)
        await click('.mode-switch .seg-item[data-value=read]')
        await wait(500)
        await grab(`${tag}-11-阅读模式滑块`)
        await click('.mode-switch .seg-item[data-value=edit]')
        // v1.4：GitHub 风格文档（HTML 渲染、徽章横排、包裹标签、折叠段落）
        await js(`await window.__test.gotoFile(${JSON.stringify(path.resolve('samples/github/README.md'))}); document.getElementById('paper').scrollTop = 0`)
        await wait(800)
        await grab(`${tag}-12-GitHub风格-编辑`)
        await scroll(900)
        await wait(400)
        await grab(`${tag}-13-GitHub风格-编辑下半`)
        await click('.mode-switch .seg-item[data-value=read]')
        await scroll(0)
        await wait(500)
        await grab(`${tag}-14-GitHub风格-阅读`)
        await scroll(700)
        await wait(400)
        await grab(`${tag}-15-GitHub风格-阅读下半`)
        await click('.mode-switch .seg-item[data-value=edit]')
        // v1.5：翻页索引（属性区小标签、已指定、找不到、更改按钮、占位卡片、选择弹窗）
        await js(`await window.__test.openFolder(${JSON.stringify(path.resolve('samples/索引'))})`)
        await wait(500)
        await js(`await window.__test.gotoFile(${JSON.stringify(path.resolve('samples/索引/子/04-丁.md'))}, { turn: false })`)
        await wait(700)
        await js(`document.querySelector('#sideSlot .seg-item[data-value=files]')?.click()`)
        await js(`const b = document.querySelector('#pager .pager-slot[data-side=prev] .pager-edit'); if (b) b.style.opacity = '1'`)
        await grab(`${tag}-16-翻页索引-编辑`)
        await js(`await window.__test.gotoFile(${JSON.stringify(path.resolve('samples/索引/子/03-丙.md'))}, { turn: false })`)
        await wait(700)
        await grab(`${tag}-17-翻页索引-占位卡片`)
        await js(`window.__test.editIndex('next')`)
        await wait(500)
        await grab(`${tag}-18-指定弹窗`, `if (!document.querySelector('.pick-modal')) window.__test.editIndex('next')`)
        await js(`document.querySelector('.modal [data-act=cancel]')?.click()`)
        await wait(300)
        await click('.mode-switch .seg-item[data-value=read]')
        await wait(500)
        await grab(`${tag}-19-翻页索引-阅读`)
        await click('.mode-switch .seg-item[data-value=edit]')
      }
      await setTheme('light')
      await js(`localStorage.removeItem('theme')`)
    } catch (e) {
      console.error(e)
    }
    if (skipped.length) fs.writeFileSync(path.join(outDir, '改存程序画面的截图.txt'), skipped.join('\n'), 'utf8')
    app.exit(0)
  })
})
