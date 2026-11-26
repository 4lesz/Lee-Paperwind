// 自测脚本：驱动真实 Electron 应用，按验收标准编号逐项检查并截图
// 用法：npx vite build && npx electron scripts/selftest.cjs <样本.md> <输出目录>
const { app, dialog, BrowserWindow, Menu } = require('electron')

// 用模拟对话框代替系统对话框，自动选择「保存/不保存/取消」，以验证各分支逻辑
const fake = { box: [], save: [], open: 0, boxAnswer: 2, saveAnswer: null }
dialog.showMessageBox = async (_w, opts) => {
  fake.box.push(opts.message)
  return { response: fake.boxAnswer }
}
dialog.showSaveDialog = async (_w, opts) => {
  fake.save.push(opts.defaultPath)
  return fake.saveAnswer ? { canceled: false, filePath: fake.saveAnswer } : { canceled: true }
}
dialog.showOpenDialog = async () => {
  fake.open++
  return fake.openAnswer ? { canceled: false, filePaths: [fake.openAnswer] } : { canceled: true, filePaths: [] }
}
// 外部链接只记录、不真的打开浏览器
const { shell } = require('electron')
fake.external = []
shell.openExternal = async (url) => {
  fake.external.push(url)
}
// 「在资源管理器中显示」「用默认程序打开」只记录，验证非 Markdown 文件绝不会被运行（AC-S04）
fake.shown = []
fake.opened = []
shell.showItemInFolder = (p) => fake.shown.push(p)
shell.openPath = async (p) => {
  fake.opened.push(p)
  return ''
}
const fs = require('node:fs')
const path = require('node:path')

const outDir = path.resolve(process.argv[process.argv.length - 1])
const mdFile = path.resolve(process.argv.find((a) => a.endsWith('.md')))
fs.mkdirSync(outDir, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 使用独立的数据目录，避免测试产生的草稿、主题设置写进日常使用的应用数据
app.setPath('userData', path.join(outDir, 'userdata'))
fs.rmSync(path.join(outDir, 'userdata'), { recursive: true, force: true })

require('../electron/main.cjs')

let started = false
app.on('browser-window-created', (_e, win) => {
  if (started) return
  started = true
  const consoleErrors = []
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level
    if (level === 'error' || level === 3) consoleErrors.push(e.message ?? e.params?.message)
  })

  win.webContents.once('did-finish-load', async () => {
    const results = []
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`)
    const shotNotes = []
    const inputStats = { real: 0, synthetic: 0 }
    const ensureVisible = () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
    }
    const shot = async (name) => {
      ensureVisible()
      try {
        const img = await win.webContents.capturePage()
        fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG())
      } catch (e) {
        shotNotes.push(name + ': ' + e.message) // 截图失败不影响验收结论，只记录
      }
    }
    const check = (id, desc, pass, detail) => results.push({ id, desc, pass: !!pass, detail })

    // 页面内的小工具（页面重新加载后需要重新注入）
    const injectT = (wc = win.webContents) => wc.executeJavaScript(`
      window.__keepPopoverOnBlur = true
      window.T = {
        e: () => window.__editor,
        md: () => window.__editor.storage.markdown.getMarkdown(),
        dirty: () => !document.getElementById('dirtyDot').hidden,
        sleep: (ms) => new Promise(r => setTimeout(r, ms)),
        click: (sel) => { const el = document.querySelector(sel); if (!el) throw new Error('找不到 ' + sel); el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); el.click() },
        findText: (t) => { let pos = null; window.__editor.state.doc.descendants((n, p) => { if (pos === null && n.isText && n.text.includes(t)) pos = p + n.text.indexOf(t) }); return pos },
        select: (t) => { const p = T.findText(t); window.__editor.commands.setTextSelection({ from: p, to: p + t.length }); return p },
        pickKey: async (k) => {
          const parts = k.split('/')
          for (let i = 1; i < parts.length; i++) {
            const f = document.querySelector('.pick-folder[data-key="' + parts.slice(0, i).join('/') + '"]')
            if (f && !f.classList.contains('open')) { f.click(); await T.sleep(150) }
          }
          document.querySelector('.pick-item[data-key="' + k + '"]').click()
        },
      }; true`)
    await injectT()

    try {
      // 模拟按键只发送给拥有系统焦点的窗口：测试期间置顶并保持焦点
      win.setAlwaysOnTop(true)
      // 窗口被遮挡或最小化时也保持计时器和绘制正常运行
      win.webContents.setBackgroundThrottling(false)
      win.focus()
      await wait(1500)
      const original = fs.readFileSync(mdFile, 'utf8')
      await shot('01-打开示例-浅色')

      // ---------- AC-M01 渲染 ----------
      const r = await js(`
        const q = (s) => document.querySelectorAll('.prose ' + s).length
        const img = document.querySelector('.prose img:not(.ProseMirror-separator)')
        return {
          h: [q('h1'), q('h2'), q('h3')], strong: q('strong'), em: q('em'), s: q('s'), mark: q('mark'), u: q('u'),
          code: q(':not(pre) > code'), a: q('a'), tasks: q('ul[data-type=taskList] li'), checked: q('li[data-checked=true]'),
          ul: q('ul:not([data-type]) li'), ol: q('ol li'), pre: q('pre'), hl: q('pre .hljs-keyword'), quote: q('blockquote'),
          table: q('table'), hr: q('hr'), img: !!img, imgLoaded: !!img && img.complete && img.naturalWidth > 0, imgSrc: img && img.src,
          title: document.title, dirty: T.dirty(), name: document.getElementById('docName').textContent,
        }`)
      check('AC-M01', '所有语法元素正确渲染',
        r.h.every((n) => n > 0) && r.strong && r.em && r.s && r.mark && r.u && r.code && r.a && r.tasks === 3 && r.checked === 1 &&
          r.ul >= 3 && r.ol === 2 && r.pre === 2 && r.hl > 0 && r.quote && r.table && r.hr && r.img, r)
      check('AC-R03', '相对路径本地图片能显示', r.imgLoaded, r.imgSrc)
      check('AC-F02', '打开后显示文件名且没有未保存标记', r.name === '示例.md' && !r.dirty && r.title.startsWith('示例.md'), { name: r.name, title: r.title, dirty: r.dirty })

      // ---------- AC-M02 往返保真 ----------
      const md = await js(`return T.md()`)
      const same = md.trim() === original.trim()
      let firstDiff = null
      if (!same) {
        const a = md.trim().split('\n'), b = original.trim().split('\n')
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { firstDiff = { line: i + 1, got: a[i], want: b[i] }; break }
      }
      check('AC-M02', '不修改时导出的 Markdown 与原文件一致', same, firstDiff)

      // ---------- AC-E02 / E03 / E04 文字样式 ----------
      const marks = await js(`
        const out = {}
        const cases = [['bold','**'],['italic','*'],['underline','<u>'],['strike','~~'],['highlight','=='],['code','\`']]
        for (const [cmd, syntax] of cases) {
          T.select('这是一段')
          T.click('#toolbar [data-cmd=' + cmd + ']')
          await T.sleep(50)
          const md1 = T.md().split('\\n').find(l => l.includes('这是一段'))
          const active = document.querySelector('#toolbar [data-cmd=' + cmd + ']').classList.contains('active')
          const sel = T.e().state.selection
          const keptSelection = sel.to - sel.from === 4 && document.activeElement === T.e().view.dom
          T.click('#toolbar [data-cmd=' + cmd + ']')
          await T.sleep(50)
          const md2 = T.md().split('\\n').find(l => l.includes('这是一段'))
          out[cmd] = { applied: md1.startsWith(syntax + '这是一段') || md1.startsWith(syntax), active, keptSelection, removed: md2.startsWith('这是一段'), md1 }
        }
        return out`)
      check('AC-E02', '6 种文字样式可开启/取消，按钮显示按下态',
        Object.values(marks).every((m) => m.applied && m.active && m.removed), marks)
      check('AC-E03', '点击按钮后选区和焦点保持', Object.values(marks).every((m) => m.keptSelection), Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v.keptSelection])))

      const e04 = await js(`
        const p = T.findText('粗体'); T.e().commands.setTextSelection(p + 1); await T.sleep(50)
        const inBold = document.querySelector('#toolbar [data-cmd=bold]').classList.contains('active')
        const p2 = T.findText('这是一段'); T.e().commands.setTextSelection(p2 + 1); await T.sleep(50)
        const outBold = document.querySelector('#toolbar [data-cmd=bold]').classList.contains('active')
        return { inBold, outBold }`)
      check('AC-E04', '光标在粗体中按钮按下，移出后恢复', e04.inBold && !e04.outBold, e04)

      // ---------- AC-F05 / F06 未保存标记 ----------
      const f05 = await js(`
        await T.sleep(400)
        const before = T.dirty()
        const p = T.findText('这是一段'); T.e().chain().setTextSelection(p).insertContent('X').run()
        await T.sleep(50)
        const afterEdit = T.dirty(), title = document.title
        T.e().commands.undo(); await T.sleep(500)
        return { before, afterEdit, title, afterUndo: T.dirty() }`)
      check('AC-F05', '修改后出现未保存圆点和标题 ●', !f05.before && f05.afterEdit && f05.title.startsWith('●'), f05)
      check('AC-F06', '改回原样后圆点消失', !f05.afterUndo, f05)

      // ---------- AC-E05 「Aa」段落样式 ----------
      const e05 = await js(`
        const p = T.findText('好的工具'); T.e().commands.setTextSelection(p + 1)
        // 先移出引用，放到普通段落
        const q = T.findText('还有一个'); T.e().commands.setTextSelection(q + 1)
        const res = {}
        for (const [i, name, check] of [[0,'h1',()=>T.e().isActive('heading',{level:1})],[1,'h2',()=>T.e().isActive('heading',{level:2})],[2,'h3',()=>T.e().isActive('heading',{level:3})],[4,'mono',()=>T.e().isActive('codeBlock')],[3,'p',()=>T.e().isActive('paragraph')]]) {
          T.click('#toolbar [data-cmd=style]'); await T.sleep(300)
          const items = document.querySelectorAll('.popover .pop-item')
          items[i].click(); await T.sleep(150)
          res[name] = check()
        }
        T.click('#toolbar [data-cmd=style]'); await T.sleep(300)
        res.checkMark = document.querySelectorAll('.popover .pop-item')[3].classList.contains('checked')
        res.preview = getComputedStyle(document.querySelector('.popover .pv-h1')).fontSize
        T.click('#toolbar [data-cmd=style]'); await T.sleep(200)
        return res`)
      check('AC-E05', '「Aa」面板切换 标题/小标题/副标题/等宽/正文，当前项有 ✓，有字号预览',
        e05.h1 && e05.h2 && e05.h3 && e05.mono && e05.p && e05.checkMark && e05.preview === '24px', e05)
      await js(`for (let i = 0; i < 12; i++) T.e().commands.undo()`)

      // ---------- AC-E06 列表与块 ----------
      const e06 = await js(`
        const res = {}
        for (const [cmd, node] of [['taskList','taskList'],['bulletList','bulletList'],['orderedList','orderedList'],['quote','blockquote'],['codeBlock','codeBlock']]) {
          const q = T.findText('还有一个'); T.e().commands.setTextSelection(q + 1)
          T.click('#toolbar [data-cmd=' + cmd + ']'); await T.sleep(50)
          const on = T.e().isActive(node)
          T.click('#toolbar [data-cmd=' + cmd + ']'); await T.sleep(50)
          res[cmd] = on && !T.e().isActive(node)
        }
        // 清单勾选框可点击
        const box = document.querySelectorAll('.prose ul[data-type=taskList] input')[1]
        box.click(); await T.sleep(50)
        res.checkToggle = T.md().includes('- [x] 做桌面版')
        box.click(); await T.sleep(50)
        return res`)
      check('AC-E06', '清单/无序/有序/引用/代码块可开关，勾选框可点击', Object.values(e06).every(Boolean), e06)

      // ---------- AC-E07 代码块语言 ----------
      const e07 = await js(`
        T.e().commands.focus('end')
        T.e().chain().focus('end').insertContent({ type: 'paragraph' }).run()
        T.click('#toolbar [data-cmd=codeBlock]')
        T.e().commands.insertContent('SELECT name FROM users;')
        await T.sleep(100)
        const pill = document.querySelector('#toolbar .context .pill')
        const shown = !!pill
        pill.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); pill.click(); await T.sleep(300)
        const opt = [...document.querySelectorAll('.popover .pop-item')].find(b => b.textContent.trim() === 'SQL')
        opt.click(); await T.sleep(150)
        const md = T.md()
        return { shown, label: pill.textContent.trim(), saved: md.includes('\`\`\`sql\\nSELECT name FROM users;\\n\`\`\`'), colored: !!document.querySelector('pre[data-language=sql] .hljs-keyword') }`)
      check('AC-E07', '代码块显示语言选择，选 SQL 后着色并保存为 ```sql', e07.shown && e07.saved && e07.colored && e07.label === 'SQL', e07)
      await shot('02-代码块语言')

      // ---------- AC-E09 浮动菜单 ----------
      const e09 = await js(`
        document.getElementById('paper').scrollTop = 0; await T.sleep(100)
        T.select('普通文字'); T.e().commands.focus()
        const vis = () => { const box = document.querySelector('[data-tippy-root]'); return !!box && getComputedStyle(box).visibility !== 'hidden' && !!box.querySelector('#bubble') && box.getBoundingClientRect().height > 0 }
        let shown = false
        for (let i = 0; i < 20 && !shown; i++) { await T.sleep(100); shown = vis() }
        return { shown }`)
      await shot('03-浮动菜单')
      const e09b = await js(`
        const shownNow = () => { const box = document.querySelector('[data-tippy-root]'); return !!box && getComputedStyle(box).visibility !== 'hidden' }
        const p = T.findText('SELECT name'); T.e().commands.setTextSelection({ from: p, to: p + 6 })
        let inCode = true
        for (let i = 0; i < 12 && inCode; i++) { await T.sleep(100); inCode = shownNow() }
        T.e().commands.setTextSelection(p)
        let collapsed = true
        for (let i = 0; i < 12 && collapsed; i++) { await T.sleep(100); collapsed = shownNow() }
        return { inCode, collapsed }`)
      check('AC-E09', '选中文字出现浮动菜单；代码块中、无选区时不出现', e09.shown && !e09b.inCode && !e09b.collapsed, { ...e09, ...e09b })

      // ---------- AC-E12 撤销/重做 ----------
      const e12 = await js(`
        const before = T.md()
        T.select('普通文字'); T.click('#toolbar [data-cmd=bold]'); await T.sleep(50)
        const changed = T.md() !== before
        T.e().commands.undo(); const undone = T.md() === before
        T.e().commands.redo(); const redone = T.md() !== before
        T.e().commands.undo()
        return { changed, undone, redone }`)
      check('AC-E12', '撤销/重做对格式栏操作有效', e12.changed && e12.undone && e12.redone, e12)

      // ---------- AC-E17 浮动菜单里的「Aa」段落样式 ----------
      const e17 = await js(`
        const beforeMd = T.md()
        T.select('普通文字'); T.e().commands.focus()
        let aa = null
        for (let i = 0; i < 20 && !aa; i++) { await T.sleep(100); aa = document.querySelector('#bubble [data-cmd=style]') }
        const first = document.querySelector('#bubble .fmt-btn')
        const bubbleHasAa = !!aa && aa === first && aa.textContent.trim() === 'Aa'
        if (!aa) return { bubbleHasAa }
        aa.click(); await T.sleep(150)
        const pop = document.querySelector('.popover.styles')
        const labels = pop ? [...pop.querySelectorAll('.pop-item')].map(b => b.textContent.trim()) : []
        const hasStyles = !!pop && labels.length === 5 && labels.includes('标题') && labels.includes('正文')
        const headBtn = pop && [...pop.querySelectorAll('.pop-item')].find(b => b.textContent.includes('标题'))
        if (headBtn) headBtn.click()
        await T.sleep(300)
        const toHeading = T.e().isActive('heading', { level: 1 })
        const selKept = T.e().state.selection.from < T.e().state.selection.to
        const popClosed = !document.querySelector('.popover.styles')
        T.e().commands.undo(); await T.sleep(150)
        const backToP = !T.e().isActive('heading') && T.md() === beforeMd
        return { bubbleHasAa, hasStyles, labels, toHeading, selKept, popClosed, backToP }`)
      check('AC-E17', '选中文字后浮动菜单最左端有「Aa」，可从下拉切换标题/正文，选区保持',
        e17.bubbleHasAa && e17.hasStyles && e17.toHeading && e17.selKept && e17.popClosed && e17.backToP, e17)

      // ---------- AC-E13 表格（自动部分） ----------
      const e13 = await js(`
        const p = T.findText('打开文件'); T.e().commands.setTextSelection(p + 1); await T.sleep(100)
        const pill = document.querySelector('#toolbar .context .pill')
        const label = pill && pill.textContent.trim()
        pill.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); pill.click(); await T.sleep(300)
        const items = [...document.querySelectorAll('.popover .pop-item')].map(b => b.textContent.trim())
        const rowsBefore = document.querySelectorAll('.prose table tr').length
        document.querySelectorAll('.popover .pop-item')[0].click(); await T.sleep(100)
        const rowsAfter = document.querySelectorAll('.prose table tr').length
        T.e().commands.undo()
        return { label, items, added: rowsAfter === rowsBefore + 1 }`)
      check('AC-E13', '光标在表格中出现「表格」按钮，插入行有效', e13.label === '表格' && e13.added && e13.items.includes('删除表格'), e13)

      // ---------- AC-M07 源码模式 ----------
      const m07 = await js(`
        const wasDirty = T.dirty()
        T.click('.titlebar [data-cmd=source]'); await T.sleep(200)
        const src = document.getElementById('source')
        const visible = !src.hidden, hasMd = src.value.startsWith(${JSON.stringify(original.split(/\r?\n/)[0])})
        T.click('.titlebar [data-cmd=source]'); await T.sleep(600)
        return { visible, hasMd, back: !document.getElementById('editor').hidden, dirtyUnchanged: T.dirty() === wasDirty }`)
      check('AC-M07', '源码模式来回切换内容正确，不产生未保存标记', m07.visible && m07.hasMd && m07.back && m07.dirtyUnchanged, m07)

      // ---------- AC-R01 大纲 ----------
      const r01 = await js(`
        const items = [...document.querySelectorAll('#outlineList li')].map(l => l.className + ':' + l.textContent)
        return { items }`)
      check('AC-R01', '大纲按层级列出标题', r01.items.length === 7 && r01.items[0].startsWith('lv1'), r01)

      // ---------- AC-R06 字数 ----------
      const r06 = await js(`return document.getElementById('stats').textContent`)
      check('AC-R06', '右下角显示字数', /^[\d,]+ 字$/.test(r06), r06)

      // ---------- 深色模式截图 ----------
      const r05 = await js(`
        const bg = () => getComputedStyle(document.querySelector('.sheet')).backgroundColor
        const sysDark = matchMedia('(prefers-color-scheme: dark)').matches
        const before = bg()
        T.click('.titlebar [data-cmd=theme]'); await T.sleep(400)
        const after = bg(), theme = document.documentElement.dataset.theme
        const saved = localStorage.getItem('theme')
        if (theme !== 'dark') { T.click('.titlebar [data-cmd=theme]'); await T.sleep(400) }
        document.getElementById('paper').scrollTop = 520; await T.sleep(300)
        return { sysDark, before, after, theme, saved, nowDark: bg() === 'rgb(35, 35, 37)' }`)
      check('AC-R05', '手动切换深浅色生效并记住', r05.before !== r05.after && r05.theme === (r05.sysDark ? 'light' : 'dark') && r05.saved === r05.theme && r05.nowDark, r05)
      // 页面主题必须与系统材质 / 窗口按钮的深浅一致（用切换按钮来回切两次，每次都检查）
      const { nativeTheme } = require('electron')
      const themeSync = []
      for (let i = 0; i < 2; i++) {
        await js(`T.click('.titlebar [data-cmd=theme]'); await T.sleep(400); return true`)
        const pageDark = await js(`return getComputedStyle(document.querySelector('.sheet')).backgroundColor === 'rgb(35, 35, 37)'`)
        themeSync.push({ pageDark, systemDark: nativeTheme.shouldUseDarkColors })
      }
      check('AC-R05c', '切换主题时页面与系统材质、窗口按钮始终一致', themeSync.every((t) => t.pageDark === t.systemDark), themeSync)
      await shot('04-深色')

      // 弹窗截图
      await js(`T.select('普通文字'); T.click('#toolbar [data-cmd=link]'); await T.sleep(400)`)
      await shot('05-链接弹窗-深色')
      await js(`document.querySelector('.modal [data-act=cancel]').click(); await T.sleep(200)`)

      // 阅读模式
      await js(`document.documentElement.dataset.theme = 'light'; window.api.setTheme('light'); await T.sleep(300); T.click('.mode-switch .seg-item[data-value=read]'); await T.sleep(400)`)
      const r04 = await js(`return { editable: T.e().isEditable, barHidden: getComputedStyle(document.querySelector('.formatbar-wrap')).display === 'none' }`)
      check('AC-R04', '阅读模式不可编辑且隐藏格式栏', !r04.editable && r04.barHidden, r04)
      await shot('06-阅读模式')
      await js(`T.click('.mode-switch .seg-item[data-value=edit]'); await T.sleep(200)`)

      // 恢复主题设置，避免影响下次启动
      await js(`localStorage.removeItem('theme'); return true`)

      // =================== 第二部分：真实键盘与真实文件 ===================
      // 键盘：窗口有系统焦点时发送真实按键；拿不到焦点（例如测试时正在使用电脑）时，
      // 向页面派发等价的键盘事件。两种方式的次数都会记录在结果里。
      const key = async (k, mods = []) => {
        ensureVisible()
        if (!win.isFocused()) {
          win.focus()
          await wait(150)
        }
        if (win.isFocused()) {
          inputStats.real++
          win.webContents.focus()
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods })
        } else {
          inputStats.synthetic++
          await js(`
            const k = ${JSON.stringify(k)}, mods = ${JSON.stringify(mods)}
            const shift = mods.includes('shift')
            const named = { Return: 'Enter', Escape: 'Escape' }
            const key = named[k] || (/^[a-z]$/i.test(k) ? (shift ? k.toUpperCase() : k.toLowerCase()) : k)
            const ev = new KeyboardEvent('keydown', { key, ctrlKey: mods.includes('control'), shiftKey: shift, altKey: mods.includes('alt'), bubbles: true, cancelable: true })
            const kc = key === 'Enter' ? 13 : key === 'Escape' ? 27 : k.toUpperCase().charCodeAt(0)
            Object.defineProperty(ev, 'keyCode', { get: () => kc })
            ;(document.activeElement || document.body).dispatchEvent(ev)
            return true`)
        }
        await wait(120)
      }
      // 菜单快捷键：先核对菜单里登记了该快捷键；窗口有系统焦点时按真实按键，
      // 没有焦点（Windows 不允许后台程序抢前台）时直接触发该菜单项
      const menuPaths = []
      const menuKey = async (acc) => {
        const found = []
        const walk = (menu) => menu.items.forEach((i) => { if (i.accelerator === acc) found.push(i); if (i.submenu) walk(i.submenu) })
        walk(Menu.getApplicationMenu())
        if (!found.length) throw new Error('菜单中没有登记快捷键 ' + acc)
        ensureVisible()
        if (win.isFocused()) {
          const parts = acc.replace('CmdOrCtrl', 'control').split('+')
          const k = parts.pop()
          await key(k, parts.map((x) => x.toLowerCase()))
          menuPaths.push(acc + ' 真实按键')
        } else {
          found[0].click(undefined, win, win.webContents)
          await wait(150)
          menuPaths.push(acc + ' 菜单项')
        }
      }
      const type = async (text) => {
        for (const ch of text) {
          if (ch === '\n') await key('Return')
          else {
            if (!win.isFocused()) {
              win.focus()
              await wait(150)
            }
            if (win.isFocused()) {
              inputStats.real++
              win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
            } else {
              inputStats.synthetic++
              await js(`
                const v = T.e().view, { from, to } = v.state.selection, t = ${JSON.stringify(ch)}
                if (!v.someProp('handleTextInput', (f) => f(v, from, to, t))) v.dispatch(v.state.tr.insertText(t, from, to))
                return true`)
            }
          }
          await wait(25)
        }
        await wait(150)
      }
      // 准备一个文件名含空格、中文、括号的临时文件（AC-F18）
      const tmpDir = path.join(outDir, 'tmp')
      // Windows 上刚被其他进程放开的文件可能短暂删不掉（ENOTEMPTY），重试几次
      for (let i = 0; i < 3; i++) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true })
          break
        } catch {
          await wait(300)
        }
      }
      fs.mkdirSync(tmpDir, { recursive: true })
      const tmpFile = path.join(tmpDir, '保存 测试 (1).md')
      fs.writeFileSync(tmpFile, '# 键盘测试\n\n这是一段文字\n', 'utf8')
      const load = async (p) => {
        const content = fs.readFileSync(p, 'utf8').replace(/^﻿/, '')
        await js(`window.__test.loadDoc(${JSON.stringify({ path: p, name: path.basename(p), content })}); await T.sleep(400); return true`)
      }
      await load(tmpFile)
      win.focus()
      win.webContents.focus()

      // AC-E10 编辑快捷键（逐个按下，检查效果后撤销）
      const shortcutCases = [
        ['粗体 Ctrl+B', 'B', ['control'], 'mark', 'bold'],
        ['斜体 Ctrl+I', 'I', ['control'], 'mark', 'italic'],
        ['下划线 Ctrl+U', 'U', ['control'], 'mark', 'underline'],
        ['删除线 Ctrl+Shift+X', 'X', ['control', 'shift'], 'mark', 'strike'],
        ['高亮 Ctrl+Shift+H', 'H', ['control', 'shift'], 'mark', 'highlight'],
        ['行内代码 Ctrl+E', 'E', ['control'], 'mark', 'code'],
        ['标题 Ctrl+Alt+1', '1', ['control', 'alt'], 'node', "heading',{level:1}"],
        ['小标题 Ctrl+Alt+2', '2', ['control', 'alt'], 'node', "heading',{level:2}"],
        ['副标题 Ctrl+Alt+3', '3', ['control', 'alt'], 'node', "heading',{level:3}"],
        ['无序列表 Ctrl+Shift+8', '8', ['control', 'shift'], 'node', 'bulletList'],
        ['有序列表 Ctrl+Shift+7', '7', ['control', 'shift'], 'node', 'orderedList'],
        ['清单 Ctrl+Shift+9', '9', ['control', 'shift'], 'node', 'taskList'],
        ['引用 Ctrl+Shift+B', 'B', ['control', 'shift'], 'node', 'blockquote'],
        ['代码块 Ctrl+Alt+C', 'C', ['control', 'alt'], 'node', 'codeBlock'],
      ]
      const e10 = {}
      for (const [name, k, mods, kind, what] of shortcutCases) {
        await js(`T.select('这是一段'); T.e().commands.focus(); return true`)
        await key(k, mods)
        const on = await js(`return T.e().isActive('${what.includes("'") ? what : what + "'"})`)
        await js(`T.e().commands.undo(); return true`)
        e10[name] = on
      }
      // 清除格式 Ctrl+Shift+0
      await js(`T.select('这是一段'); T.e().chain().focus().toggleBold().toggleHighlight().run(); return true`)
      await key('0', ['control', 'shift'])
      e10['清除格式 Ctrl+Shift+0'] = await js(`return !T.e().isActive('bold') && !T.e().isActive('highlight')`)
      await js(`T.e().commands.undo(); T.e().commands.undo(); return true`)
      // 正文 Ctrl+Alt+0
      await js(`const p = T.findText('键盘测试'); T.e().commands.setTextSelection(p + 1); return true`)
      await key('0', ['control', 'alt'])
      e10['正文 Ctrl+Alt+0'] = await js(`return T.e().isActive('paragraph')`)
      await js(`T.e().commands.undo(); return true`)
      // 撤销/重做
      await js(`T.select('这是一段'); return true`)
      await key('B', ['control'])
      await key('Z', ['control'])
      const undoOk = await js(`return !T.e().isActive('bold')`)
      await key('Y', ['control'])
      const redoOk = await js(`return T.e().isActive('bold')`)
      await key('Z', ['control'])
      e10['撤销 Ctrl+Z / 重做 Ctrl+Y'] = undoOk && redoOk
      // 链接 Ctrl+K 打开弹窗
      await js(`T.select('这是一段'); return true`)
      await key('K', ['control'])
      e10['链接 Ctrl+K 打开弹窗'] = await js(`return !!document.querySelector('.modal')`)
      await key('Escape')
      await wait(250)
      const e10diag = await js(`return { mode: window.__test.state.mode, active: document.activeElement && (document.activeElement.id || document.activeElement.className), bodyMode: document.body.dataset.mode }`)
      check('AC-E10', '编辑快捷键全部有效', Object.values(e10).every(Boolean), { ...e10, 诊断: e10diag })

      // AC-E11 Markdown 快捷输入
      const e11 = {}
      const inputCases = [
        ['## ', 'h2', `T.e().isActive('heading',{level:2})`],
        ['- ', '无序', `T.e().isActive('bulletList')`],
        ['1. ', '有序', `T.e().isActive('orderedList')`],
        ['[ ] ', '清单', `T.e().isActive('taskList')`],
        ['> ', '引用', `T.e().isActive('blockquote')`],
        ['```', '代码块', `T.e().isActive('codeBlock')`],
      ]
      for (const [seq, name, test] of inputCases) {
        await js(`T.e().chain().focus('end').insertContent({type:'paragraph'}).run(); return true`)
        await type(seq + (seq === '```' ? '\n' : ''))
        e11[name] = await js(`return ${test}`)
        await js(`T.e().chain().clearNodes().run(); return true`)
      }
      for (const [seq, name, syntax] of [['**粗体**', '粗体', '**粗体**'], ['==高亮==', '高亮', '==高亮=='], ['~~删除~~', '删除线', '~~删除~~'], ['`代码`', '行内代码', '`代码`']]) {
        await js(`T.e().chain().focus('end').insertContent({type:'paragraph'}).run(); return true`)
        await type(seq + ' ')
        e11[name] = await js(`return T.md().includes(${JSON.stringify(syntax)})`)
      }
      await js(`T.e().chain().focus('end').insertContent({type:'paragraph'}).run(); return true`)
      await type('---')
      e11['分割线'] = await js(`return document.querySelectorAll('.prose hr').length > 0`)
      check('AC-E11', 'Markdown 快捷输入全部有效', Object.values(e11).every(Boolean), e11)

      // ---------- AC-Q01 ~ Q11 查找替换（v0.2，验收标准 §8g） ----------
      const findDoc = [
        '# 查找测试',
        '',
        'Alice 和 alice 都在这里，ALICE 也在。',
        '',
        '苹果 Apple apple。',
        '',
        '重**要**的 **要**点。',
        '',
        '[链接 needle](https://example.com/needle)',
        '',
        '属性区外的 needle。',
        '',
        '这里是尾部文字。',
        '',
      ].join('\n')
      const openFindDoc = async () => {
        await js(`window.__test.loadDoc(${JSON.stringify({ name: '查找测试.md', content: findDoc })}); await T.sleep(500); return true`)
      }
      const findInfo = () => js(`
        const bar = document.getElementById('findbar')
        const cur = document.querySelector('.find-hit.find-current')
        return {
          open: !bar.hidden,
          replace: !document.getElementById('replaceRow').hidden,
          count: document.getElementById('findCount').textContent,
          hits: document.querySelectorAll('.find-hit').length,
          currents: document.querySelectorAll('.find-hit.find-current').length,
          currentText: cur ? cur.textContent : null,
          focus: document.activeElement ? (document.activeElement.id || '') : '',
          editorFocused: document.activeElement === T.e().view.dom,
          disabled: document.getElementById('findNext').disabled,
          mode: window.__test.state.mode,
          pos: getComputedStyle(bar).position,
        }`)
      const setFind = (q) => js(`const i = document.getElementById('findInput'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); await T.sleep(320); return true`)
      const setReplaceText = (t) => js(`document.getElementById('replaceInput').value = ${JSON.stringify(t)}; return true`)
      await openFindDoc()

      // AC-Q01 Ctrl+F 打开（不挤压布局）→ Ctrl+H 展开替换 → Esc 关闭回到编辑
      const q01a = await js(`return { open: !document.getElementById('findbar').hidden, width: document.getElementById('editor').getBoundingClientRect().width, scroll: document.getElementById('paper').scrollTop }`)
      await menuKey('CmdOrCtrl+F')
      await wait(300)
      const q01 = await findInfo()
      const q01b = await js(`return { width: document.getElementById('editor').getBoundingClientRect().width, scroll: document.getElementById('paper').scrollTop }`)
      await menuKey('CmdOrCtrl+H')
      await wait(300)
      const q01c = await findInfo()
      await key('Escape')
      await wait(250)
      const q01d = await findInfo()
      check('AC-Q01', 'Ctrl+F / Ctrl+H 打开查找条且不挤压正文，Esc 关闭回到编辑',
        !q01a.open && q01.open && !q01.replace && q01.focus === 'findInput' && q01.pos === 'absolute' &&
          Math.abs(q01b.width - q01a.width) < 1 && Math.abs(q01b.scroll - q01a.scroll) < 1 &&
          q01c.open && q01c.replace && q01c.focus === 'replaceInput' &&
          !q01d.open && !q01d.replace && q01d.editorFocused && q01d.mode === 'edit',
        { q01a, q01, q01b, q01c, q01d })

      // AC-Q02 不区分大小写、全部高亮、当前一处加重；无结果显示「无结果」
      await menuKey('CmdOrCtrl+F')
      await wait(250)
      await setFind('alice')
      const q02 = await findInfo()
      const q02texts = await js(`return [...document.querySelectorAll('.find-hit')].map((h) => h.textContent).join('|')`)
      await setFind('zzz')
      const q02b = await findInfo()
      check('AC-Q02', '不区分大小写、高亮全部匹配、当前一处加重；无结果提示「无结果」',
        q02.count === '1/3' && q02.hits === 3 && q02.currents === 1 && q02texts.toLowerCase() === 'alice|alice|alice' &&
          q02b.count === '无结果' && q02b.hits === 0 && q02b.disabled,
        { q02, q02texts, q02b })

      // AC-Q03 Enter / Shift+Enter 上下跳转、回绕，焦点留在查找框
      await js(`T.e().commands.setTextSelection(1); document.getElementById('findInput').focus(); return true`)
      await setFind('alice')
      const q03 = []
      for (const mods of [[], ['shift'], ['shift']]) {
        await key('Return', mods)
        q03.push(await findInfo())
      }
      await js(`document.getElementById('findInput').focus(); return true`)
      const q03f = await findInfo()
      check('AC-Q03', 'Enter / Shift+Enter 上下跳转并回绕，焦点留在查找框',
        q03.map((x) => x.count).join('|') === '2/3|1/3|3/3' && q03.every((x) => x.currents === 1) && q03f.focus === 'findInput' && q03f.editorFocused === false,
        q03.map((x) => x.count))

      // AC-Q04 文档改动后自动刷新；清空查询后没有结果、按钮禁用
      await js(`T.e().chain().focus('start').insertContent('alice').run(); await T.sleep(450); return true`)
      const q04a = await findInfo()
      await js(`T.e().commands.undo(); await T.sleep(450); return true`)
      const q04b = await findInfo()
      await setFind('')
      const q04c = await findInfo()
      check('AC-Q04', '文档改动后高亮自动刷新；清空查询后不显示结果并禁用按钮',
        q04a.count === '1/4' && q04a.hits === 4 && q04b.count === '1/3' && q04b.hits === 3 &&
          q04c.count === '0/0' && q04c.hits === 0 && q04c.disabled,
        { 改动后: q04a.count, 撤销后: q04b.count, 清空后: q04c.count })

      // AC-Q05 替换单个：自动跳到下一处，Ctrl+Z 一步还原
      await js(`T.e().commands.setTextSelection(1); return true`)
      await setFind('alice')
      await setReplaceText('bob')
      await js(`document.getElementById('replaceOne').click(); await T.sleep(350); return true`)
      const q05 = await js(`return { md: T.md(), count: document.getElementById('findCount').textContent, hits: document.querySelectorAll('.find-hit').length }`)
      await js(`T.e().commands.focus(); return true`)
      await key('Z', ['control'])
      await wait(450)
      const q05b = await js(`return { md: T.md(), count: document.getElementById('findCount').textContent }`)
      check('AC-Q05', '替换单个后自动跳到下一处，Ctrl+Z 一步还原',
        q05.md.includes('bob 和 alice') && q05.count === '1/2' && q05.hits === 2 &&
          q05b.md.includes('Alice 和 alice') && q05b.count === '1/3',
        { 替换后: q05, 撤销后: q05b })

      // AC-Q06 全部替换给出数量、一步撤销；a→aa 不会无限替换
      await js(`T.e().commands.setTextSelection(1); return true`)
      await setFind('alice')
      await setReplaceText('bob')
      await js(`document.getElementById('replaceAll').click(); await T.sleep(350); return true`)
      const q06 = await js(`return { md: T.md(), count: document.getElementById('findCount').textContent, toast: (document.querySelector('.toast') || {}).textContent || '' }`)
      await js(`T.e().commands.focus(); return true`)
      await key('Z', ['control'])
      await wait(450)
      const q06b = await js(`return { md: T.md(), count: document.getElementById('findCount').textContent }`)
      await js(`window.__test.loadDoc({ name: '重复替换.md', content: 'a' }); await T.sleep(300); return true`)
      await menuKey('CmdOrCtrl+F')
      await wait(250)
      await setFind('a')
      await setReplaceText('aa')
      await js(`document.getElementById('replaceAll').click(); await T.sleep(400); return true`)
      const q06c = await js(`return T.md().trim()`)
      check('AC-Q06', '全部替换提示数量、Ctrl+Z 一步还原；a→aa 不会无限替换',
        !/alice/i.test(q06.md) && q06.count === '无结果' && q06.toast.includes('共 3 处') &&
          q06b.md.includes('Alice 和 alice') && q06b.count === '1/3' && q06c === 'aa',
        { 全部替换后: q06, 撤销后: q06b, aa: q06c })

      // AC-Q07 匹配边界：不含 Markdown 标记 / 链接地址，不跨段，跨格式可匹配
      await openFindDoc()
      await menuKey('CmdOrCtrl+F')
      await wait(250)
      await setFind('needle')
      const q07a = await findInfo()
      await setFind('要的 要')
      const q07b = await findInfo()
      // 跨格式的一处匹配会被 mark 边界拆成多个 .find-hit 片段：拼起来应正好是查询词，且全部是当前匹配
      const q07bFrag = await js(`return {
        text: [...document.querySelectorAll('.find-hit')].map((e) => e.textContent).join(''),
        notCurrent: document.querySelectorAll('.find-hit:not(.find-current)').length,
      }`)
      await setFind('也在。苹果')
      const q07c = await findInfo()
      await setFind('## ')
      const q07d = await findInfo()
      await setFind('apple')
      const q07e = await findInfo()
      // 跨格式的一处匹配会被拆成多个 .find-hit 片段（mark 边界），所以按「当前一处 + 总数」判断
      check('AC-Q07', '不匹配 Markdown 标记和链接地址，不跨段，跨格式可匹配',
        q07a.hits === 2 && q07a.count.endsWith('/2') && q07bFrag.text === '要的 要' && q07bFrag.notCurrent === 0 &&
          q07b.count === '1/1' && q07c.count === '无结果' && q07d.count === '无结果' && q07e.hits === 2 && q07e.count.endsWith('/2'),
        { needle: q07a.count, needleHits: q07a.hits, 跨格式: q07b.count, 跨格式片段: q07bFrag, 跨段: q07c.count, 标记: q07d.count, apple: q07e.count })

      // AC-Q08 阅读模式可查找、Ctrl+H 切回编辑；源码模式先切编辑；切源码/换篇关闭
      await setFind('查找测试')
      await key('Escape')
      await wait(200)
      await js(`T.click('.mode-switch .seg-item[data-value=read]'); await T.sleep(300); return true`)
      await menuKey('CmdOrCtrl+F')
      await wait(300)
      await setFind('查找测试')
      const q08a = await findInfo()
      await menuKey('CmdOrCtrl+H')
      await wait(350)
      const q08b = await findInfo()
      await key('Escape')
      await wait(200)
      await js(`T.click('.titlebar [data-cmd=source]'); await T.sleep(300); return true`)
      const q08c0 = await js(`return window.__test.state.mode`)
      await menuKey('CmdOrCtrl+F')
      await wait(400)
      const q08c = await findInfo()
      await js(`T.click('.titlebar [data-cmd=source]'); await T.sleep(300); return true`)
      const q08d = await findInfo()
      await js(`T.click('.titlebar [data-cmd=source]'); await T.sleep(300); return true`)
      await menuKey('CmdOrCtrl+F')
      await wait(300)
      await js(`window.__test.loadDoc({ name: '另一篇.md', content: '# 另一篇' }); await T.sleep(400); return true`)
      const q08e = await findInfo()
      check('AC-Q08', '阅读模式可查找、Ctrl+H 切回编辑；源码模式先切编辑；切源码 / 换篇时关闭',
        q08a.count === '1/1' && q08a.hits === 1 && q08a.mode === 'read' &&
          q08b.open && q08b.replace && q08b.mode === 'edit' &&
          q08c0 === 'source' && q08c.open && q08c.mode === 'edit' && !q08d.open && q08d.mode === 'source' && !q08e.open,
        { 阅读: q08a, 阅读CtrlH: q08b, 源码前: q08c0, 源码CtrlF: q08c, 切源码: q08d, 换篇: q08e })

      // AC-Q09 长文档（约 1MB）：0.5 秒内出结果，高亮限流但计数真实
      const q09 = await js(`
        const br = String.fromCharCode(10, 10)
        const para = 'Alice 和 alice 都在这里。'.repeat(40) + br
        const content = '# 长文档' + br + para.repeat(1400)
        window.__test.loadDoc({ name: '长文档.md', content })
        await T.sleep(3000)
        const lower = content.toLowerCase()
        let total = 0, k = 0
        while ((k = lower.indexOf('alice', k)) !== -1) { total++; k += 5 }
        const input = document.getElementById('findInput')
        input.value = 'alice'
        const t0 = performance.now()
        input.dispatchEvent(new Event('input', { bubbles: true }))
        while ((document.getElementById('findCount').textContent === '0/0' || !document.querySelector('.find-hit')) && performance.now() - t0 < 6000) await T.sleep(20)
        return {
          chars: content.length,
          total,
          count: document.getElementById('findCount').textContent,
          hits: document.querySelectorAll('.find-hit').length,
          elapsed: Math.round(performance.now() - t0),
        }`)
      check('AC-Q09', '长文档（约 1MB）查找 0.5 秒内出结果，高亮限流但计数真实',
        q09.chars > 1000000 && q09.count === '1/' + q09.total && q09.hits <= 1200 && q09.elapsed <= 500,
        { ...q09, elapsed: q09.elapsed + 'ms' })

      // AC-Q10 视觉：当前匹配与其余匹配颜色不同，查找条有阴影和圆角
      await openFindDoc()
      await menuKey('CmdOrCtrl+F')
      await wait(250)
      await setFind('alice')
      await js(`document.getElementById('findNext').click(); await T.sleep(250); return true`)
      const q10 = await js(`
        const hit = document.querySelector('.find-hit')
        const cur = document.querySelector('.find-hit.find-current')
        const bs = getComputedStyle(document.getElementById('findbar'))
        return {
          hits: document.querySelectorAll('.find-hit').length,
          hitBg: getComputedStyle(hit).backgroundColor,
          curBg: getComputedStyle(cur).backgroundColor,
          curColor: getComputedStyle(cur).color,
          shadow: bs.boxShadow !== 'none',
          radius: bs.borderRadius,
        }`)
      await shot('07-查找替换')
      check('AC-Q10', '查找条与高亮符合设计规范：当前匹配加重、容器浮起',
        q10.hits === 3 && q10.hitBg !== q10.curBg && q10.curColor === 'rgb(29, 29, 31)' && q10.shadow, q10)

      // AC-Q11 查找、高亮、跳转都不改动文档内容
      const q11 = await js(`return T.md()`)
      await setFind('apple')
      await js(`document.getElementById('findNext').click(); await T.sleep(150); document.getElementById('findPrev').click(); await T.sleep(200); return true`)
      const q11b = await js(`return T.md()`)
      check('AC-Q11', '查找和高亮不改动文档内容', q11 === q11b, { 前: q11.length, 后: q11b.length })

      // 收尾：关闭查找条（恢复后面的测试要用的文档放在本段测试之后）
      await key('Escape')
      await wait(200)

      // ---------- 空文件夹与新建（v0.2.1，验收标准 §8h） ----------
      // 编号对照 docs/验收标准.md §8h：AC-F20 / F21 / F22 / F23 / F25
      // AC-F21b（有未保存修改时点「新建一篇」先弹确认框）要真点系统对话框，太脆，不写自动项；
      // 「保存 / 不保存 / 取消」三支已由 AC-F10 覆盖。
      const vSame = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      const vDir = path.join(outDir, 'v021 空文件夹')
      for (let i = 0; i < 3; i++) {
        try {
          fs.rmSync(vDir, { recursive: true, force: true })
          break
        } catch {
          await wait(300)
        }
      }
      fs.mkdirSync(vDir, { recursive: true })
      fs.writeFileSync(path.join(vDir, '说明.txt'), '不是 Markdown 文件', 'utf8')

      // AC-F20 打开没有任何 Markdown 的文件夹：侧栏切到「篇目」，显示空状态和「新建一篇」，不弹错误，当前文档不变
      const beforeF20 = await js(`return { name: document.getElementById('docName').textContent, path: window.__test.state.path, md: T.md() }`)
      const boxBefore20 = fake.box.length
      await js(`await window.__test.openFolder(${JSON.stringify(vDir)}); await T.sleep(500); return true`)
      const f20 = await js(`
        const tab = document.querySelector('#sideSlot .seg-item[data-value=files]')
        const toastEl = document.querySelector('.toast.show')
        return {
          side: document.body.dataset.side,
          tabOn: !!tab && tab.classList.contains('on') && tab.getAttribute('aria-checked') === 'true',
          empty: document.querySelector('#filesList .files-empty p')?.textContent || null,
          btn: document.querySelector('[data-new-file]')?.textContent || null,
          foot: document.querySelector('#folderFoot .folder-name')?.textContent || null,
          footTitle: document.querySelector('#folderFoot')?.title || null,
          toast: toastEl ? toastEl.textContent : null,
          toastKind: document.querySelector('.toast.show .toast-icon')?.className || null,
          dir: window.__test.folderNav.nav.dir,
          name: document.getElementById('docName').textContent,
          path: window.__test.state.path,
          md: T.md(),
        }`)
      await shot('08-空文件夹')
      check('AC-F20', '打开没有任何 Markdown 的文件夹：侧栏切到「篇目」，显示「这个文件夹里还没有 Markdown 文件」和「新建一篇」按钮，不弹错误，当前文档不变',
        f20.side === 'files' && f20.tabOn && /还没有 Markdown 文件/.test(f20.empty || '') && f20.btn === '新建一篇' &&
          vSame(f20.dir, vDir) && f20.foot === path.basename(vDir) && vSame(f20.footTitle, vDir) &&
          /info/.test(f20.toastKind || '') && !/错误|失败|无法/.test(f20.toast || '') &&
          fake.box.length === boxBefore20 && f20.name === beforeF20.name && f20.path === beforeF20.path && f20.md === beforeF20.md,
        { side: f20.side, tabOn: f20.tabOn, empty: f20.empty, btn: f20.btn, foot: f20.foot, footTitle: f20.footTitle, toast: f20.toast, toastKind: f20.toastKind, dir: f20.dir, path: f20.path, name: f20.name, mdLen: f20.md.length, boxCalls: fake.box.length - boxBefore20 })

      // AC-F21 点「新建一篇」：得到可输入的新文档（顶栏暂为「未命名.md」），篇目树仍指向那个空文件夹
      await js(`T.click('[data-new-file]'); await T.sleep(400); return true`)
      const f21clicked = await js(`return document.getElementById('docName').textContent`)
      await type('# 开篇\n空文件夹里新建的文字')
      const f21 = await js(`return {
        name: document.getElementById('docName').textContent,
        md: T.md(),
        editable: T.e().isEditable,
        dirty: T.dirty(),
        dir: window.__test.folderNav.nav.dir,
        foot: document.querySelector('#folderFoot .folder-name')?.textContent || null,
        footTitle: document.querySelector('#folderFoot')?.title || null,
        empty: document.querySelector('#filesList .files-empty p')?.textContent || null,
      }`)
      check('AC-F21', '空文件夹里点「新建一篇」：得到可输入的新文档（顶栏暂为「未命名.md」），篇目树仍指向该文件夹',
        f21clicked === '未命名.md' && f21.name === '未命名.md' && f21.editable && f21.dirty &&
          f21.md.startsWith('# 开篇') && f21.md.includes('空文件夹里新建的文字') &&
          vSame(f21.dir, vDir) && f21.foot === path.basename(vDir) && vSame(f21.footTitle, vDir) && /还没有 Markdown 文件/.test(f21.empty || ''),
        f21)

      // AC-F22 新文档 Ctrl+S：不弹保存框，按正文第一个标题存为该文件夹下的「开篇.md」
      const md22 = await js(`return T.md()`)
      const saveCallsBefore = fake.save.length
      const boxBefore22 = fake.box.length
      await menuKey('CmdOrCtrl+S')
      await wait(800)
      const f22 = await js(`return {
        name: document.getElementById('docName').textContent,
        dirty: T.dirty(),
        toast: (document.querySelector('.toast.show') || {}).textContent || null,
        files: [...document.querySelectorAll('#filesList .file-item')].map((li) => li.title),
      }`)
      const disk22 = fs.existsSync(path.join(vDir, '开篇.md')) ? fs.readFileSync(path.join(vDir, '开篇.md'), 'utf8') : null
      await shot('09-新文档直存文件夹')
      check('AC-F22', '已打开文件夹时新建文档按 Ctrl+S：不弹保存框，按正文第一个标题存为「开篇.md」，提示「已保存」，顶栏和篇目里都变成该篇',
        fake.save.length === saveCallsBefore && fake.box.length === boxBefore22 && disk22 === md22 && f22.name === '开篇.md' && !f22.dirty &&
          /已保存/.test(f22.toast || '') && f22.files.includes('开篇.md'),
        { saveCalls: fake.save.length - saveCallsBefore, boxCalls: fake.box.length - boxBefore22, name: f22.name, dirty: f22.dirty, toast: f22.toast, files: f22.files, diskLen: disk22 ? disk22.length : null, mdLen: md22.length })

      // AC-F23 文件夹里已有「开篇.md」时再新建一篇、写同样的标题并保存：存为「开篇 2.md」，原文件不被覆盖
      fs.writeFileSync(path.join(vDir, '开篇.md'), '原有内容', 'utf8')
      await wait(400)
      const boxBefore23 = fake.box.length
      await menuKey('CmdOrCtrl+N')
      await wait(500)
      await type('# 开篇\n第二次新建的文字')
      await menuKey('CmdOrCtrl+S')
      await wait(800)
      const f23 = await js(`return {
        name: document.getElementById('docName').textContent,
        dirty: T.dirty(),
        toast: (document.querySelector('.toast.show') || {}).textContent || null,
        files: [...document.querySelectorAll('#filesList .file-item')].map((li) => li.title),
      }`)
      const secondPath = path.join(vDir, '开篇 2.md')
      const secondDisk = fs.existsSync(secondPath) ? fs.readFileSync(secondPath, 'utf8') : null
      const firstDisk = fs.readFileSync(path.join(vDir, '开篇.md'), 'utf8')
      check('AC-F23', '文件夹里已有「开篇.md」时再次新建并保存：存为「开篇 2.md」，原有的「开篇.md」不被覆盖',
        fake.box.length === boxBefore23 && !!secondDisk && secondDisk.includes('第二次新建的文字') && firstDisk === '原有内容' &&
          f23.name === '开篇 2.md' && !f23.dirty && f23.files.includes('开篇 2.md'),
        { name: f23.name, dirty: f23.dirty, files: f23.files, firstLen: firstDisk.length, secondLen: secondDisk ? secondDisk.length : null })

      // AC-F26 标题命名的清洗与兜底：代码块里的 # 不算标题、格式符号和非法字符去掉、纯符号/无标题退回「未命名.md」、超长截断
      const md26 = '```js\n# 注释不是标题\n```\n\n# **第一章**：开始\n\n正文\n'
      await menuKey('CmdOrCtrl+N')
      await wait(400)
      await js(`window.__test.loadDoc({ path: null, name: '未命名.md', content: ${JSON.stringify(md26)} }); await T.sleep(400); return true`)
      await menuKey('CmdOrCtrl+S')
      await wait(800)
      const f26a = await js(`return { name: document.getElementById('docName').textContent, dirty: T.dirty() }`)
      const f26aDisk = fs.existsSync(path.join(vDir, '第一章 开始.md')) ? fs.readFileSync(path.join(vDir, '第一章 开始.md'), 'utf8') : null

      const longTitle = '长'.repeat(80)
      await menuKey('CmdOrCtrl+N')
      await wait(400)
      await js(`window.__test.loadDoc({ path: null, name: '未命名.md', content: ${JSON.stringify('# ' + longTitle + '\n\n正文\n')} }); await T.sleep(400); return true`)
      await menuKey('CmdOrCtrl+S')
      await wait(800)
      const longFile = fs.readdirSync(vDir).find((n) => n.startsWith('长'))
      const f26b = await js(`return { name: document.getElementById('docName').textContent, dirty: T.dirty() }`)

      await menuKey('CmdOrCtrl+N')
      await wait(400)
      await js(`window.__test.loadDoc({ path: null, name: '未命名.md', content: ${JSON.stringify('# **\n\n正文\n')} }); await T.sleep(400); return true`)
      await menuKey('CmdOrCtrl+S')
      await wait(800)
      const f26c = await js(`return { name: document.getElementById('docName').textContent, dirty: T.dirty() }`)
      const f26cDisk = fs.existsSync(path.join(vDir, '未命名.md')) ? fs.readFileSync(path.join(vDir, '未命名.md'), 'utf8') : null
      check('AC-F26', '标题命名的清洗与兜底：代码块里的 # 不算标题；「# **第一章**：开始」→「第一章 开始.md」；超长标题截断到 60 字；标题只剩符号时退回「未命名.md」',
        f26a.name === '第一章 开始.md' && !!f26aDisk && f26aDisk.includes('第一章') && !f26a.dirty &&
          !!longFile && longFile.length === '长'.repeat(60).length + 3 && f26b.name === longFile && !f26b.dirty &&
          f26c.name === '未命名.md' && !!f26cDisk && f26cDisk.includes('正文') && !f26c.dirty &&
          !fs.existsSync(path.join(vDir, '注释不是标题.md')),
        { cleaned: f26a, cleanedDiskLen: f26aDisk ? f26aDisk.length : null, longName: longFile, longTitleLen: f26b.name.length, fallback: f26c })

      // AC-F25 保存后篇目树按新文件刷新，两篇都能点开；window.__test.folderNav 里能查到该文件夹
      const f25 = await js(`return {
        dir: window.__test.folderNav.nav.dir,
        files: window.__test.folderNav.nav.files.map((f) => f.path),
        current: document.getElementById('docName').textContent,
      }`)
      const f25clicked = await js(`const li = [...document.querySelectorAll('#filesList .file-item')].find((x) => x.title === '开篇.md')
        if (li) { li.click(); await T.sleep(1200) }
        return !!li`)
      const f25opened = await js(`return { path: window.__test.state.pendingPath || window.__test.state.path, name: document.getElementById('docName').textContent }`)
      check('AC-F25', '在空文件夹新建并保存后，篇目树按新文件刷新、新文件可以点开，folderNav 指向该文件夹',
        f25clicked && vSame(f25.dir, vDir) &&
          f25.files.some((p) => vSame(p, path.join(vDir, '开篇.md'))) && f25.files.some((p) => vSame(p, path.join(vDir, '开篇 2.md'))) &&
          vSame(f25opened.path, path.join(vDir, '开篇.md')) && f25opened.name === '开篇.md',
        { ...f25, opened: f25opened })

      // AC-F27 顶栏文件名点击就地改名（v0.2.2）：未保存时先改待保存名，Ctrl+S 就用它；已保存时连磁盘文件名一起改
      // 输入框里的名字直接设值（真实逐字输入对 <input> 在拿不到焦点时会打进编辑器，不适合用来改名）
      const fillName = (sel, v) => js(`const i = document.querySelector(${JSON.stringify(sel)})
        if (!i) throw new Error('找不到 ' + ${JSON.stringify(sel)})
        i.value = ${JSON.stringify(v)}
        i.dispatchEvent(new Event('input', { bubbles: true }))
        return true`)
      await menuKey('CmdOrCtrl+N')
      await wait(400)
      await js(`T.click('#docName'); await T.sleep(200); return !document.getElementById('docNameInput').hidden`)
      await fillName('#docNameInput', '顶栏改名')
      await key('Return')
      await wait(500)
      const f27a = await js(`return {
        name: document.getElementById('docName').textContent,
        open: !document.getElementById('docNameInput').hidden,
        toast: (document.querySelector('.toast.show') || {}).textContent || null,
      }`)
      await menuKey('CmdOrCtrl+S')
      await wait(800)
      const f27aDisk = fs.existsSync(path.join(vDir, '顶栏改名.md'))
      await js(`T.click('#docName'); await T.sleep(200); return true`)
      await fillName('#docNameInput', '改名后')
      await key('Return')
      await wait(800)
      const f27 = await js(`return {
        name: document.getElementById('docName').textContent,
        path: window.__test.state.path,
        dirty: T.dirty(),
        files: [...document.querySelectorAll('#filesList .file-item')].map((li) => li.title),
      }`)
      const f27oldGone = !fs.existsSync(path.join(vDir, '顶栏改名.md'))
      const f27newDisk = fs.existsSync(path.join(vDir, '改名后.md'))
      check('AC-F27', '点顶栏文件名就地改名：未保存的新文档改名后按 Ctrl+S 直接存成该名字；已保存的文档改名后磁盘文件名和篇目树一起更新',
        f27a.name === '顶栏改名.md' && !f27a.open && /保存时用这个文件名/.test(f27a.toast || '') && f27aDisk &&
          f27.name === '改名后.md' && /改名后\.md$/i.test(f27.path || '') && !f27.dirty && f27.files.includes('改名后.md') &&
          f27oldGone && f27newDisk,
        { unsaved: f27a, savedOnDisk: f27aDisk, renamed: f27, oldGone: f27oldGone, newDisk: f27newDisk })

      // AC-F28 篇目树右键「重命名」：就地改名，磁盘文件名和列表一起更新（改的不是当前篇）
      await js(`const li = [...document.querySelectorAll('#filesList .file-item')].find((x) => x.title === '开篇 2.md')
        li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 260, clientY: 240 }))
        await T.sleep(200)
        return !!document.querySelector('.files-menu')`)
      const f28menu = await js(`return document.querySelector('.files-menu button')?.textContent || null`)
      await js(`document.querySelector('.files-menu button').click(); await T.sleep(300); return true`)
      const f28input = await js(`const i = document.querySelector('.file-rename')
        return { has: !!i, value: i ? i.value : null, focused: i === document.activeElement }`)
      await fillName('.file-rename', '篇目改名')
      await key('Return')
      await wait(800)
      const f28 = await js(`return {
        files: [...document.querySelectorAll('#filesList .file-item')].map((li) => li.title),
        menu: !!document.querySelector('.files-menu'),
        input: !!document.querySelector('.file-rename'),
        name: document.getElementById('docName').textContent,
      }`)
      const f28oldGone = !fs.existsSync(path.join(vDir, '开篇 2.md'))
      const f28newDisk = fs.existsSync(path.join(vDir, '篇目改名.md'))
      check('AC-F28', '篇目树右键文件显示「重命名」，就地输入后磁盘文件名和列表一起更新，当前打开的那篇不受影响',
        f28menu === '重命名' && f28input.has && f28input.value === '开篇 2' && f28input.focused &&
          f28.files.includes('篇目改名.md') && !f28.files.includes('开篇 2.md') && !f28.menu && !f28.input &&
          f28.name === '改名后.md' && f28oldGone && f28newDisk,
        { menu: f28menu, input: f28input, after: f28, oldGone: f28oldGone, newDisk: f28newDisk })

      // AC-F29 改名的异常处理：重名提示「已经有同名文件了」不改；非法字符换成空格；不写扩展名自动补 .md
      await js(`T.click('#docName'); await T.sleep(200); return true`)
      await fillName('#docNameInput', '篇目改名')
      await key('Return')
      await wait(600)
      const f29exists = await js(`return {
        name: document.getElementById('docName').textContent,
        toast: (document.querySelector('.toast.show') || {}).textContent || null,
        open: !document.getElementById('docNameInput').hidden,
      }`)
      const f29oldKept = fs.existsSync(path.join(vDir, '改名后.md'))
      await js(`T.click('#docName'); await T.sleep(200); return true`)
      await fillName('#docNameInput', '非法/名字:测试')
      await key('Return')
      await wait(800)
      const f29 = await js(`return {
        name: document.getElementById('docName').textContent,
        path: window.__test.state.path,
        files: [...document.querySelectorAll('#filesList .file-item')].map((li) => li.title),
      }`)
      const f29disk = fs.existsSync(path.join(vDir, '非法 名字 测试.md'))
      check('AC-F29', '改名遇到重名提示「已经有同名文件了」并保持原名；非法字符换成空格；不写扩展名自动补 .md',
        f29exists.name === '改名后.md' && /已经有同名文件了/.test(f29exists.toast || '') && !f29exists.open &&
          f29oldKept &&
          f29.name === '非法 名字 测试.md' && /非法 名字 测试\.md$/i.test(f29.path || '') &&
          f29.files.includes('非法 名字 测试.md') && f29disk,
        { exists: f29exists, oldKept: f29oldKept, illegal: f29, disk: f29disk })

      // 清理：先解除对该临时文件夹的关注，再删除临时文件与临时文件夹（Windows 上偶发 ENOTEMPTY，重试几次）
      await js(`await window.__test.folderNav.setDir(null); await T.sleep(200); return true`)
      for (let i = 0; i < 6; i++) {
        try {
          fs.rmSync(vDir, { recursive: true, force: true })
          break
        } catch {
          await wait(300)
        }
      }
      if (fs.existsSync(vDir)) {
        await wait(500)
        try {
          fs.rmSync(vDir, { recursive: true, force: true })
        } catch {}
      }

      // 恢复后面的测试要用的文档
      await load(tmpFile)

      // AC-F07 / F13 Ctrl+S 直接覆盖保存，UTF-8 无 BOM
      await js(`T.e().chain().focus('end').insertContent('保存校验ABC').run(); await T.sleep(400); return true`)
      const dirtyBefore = await js(`return T.dirty()`)
      await menuKey('CmdOrCtrl+S')
      await wait(800)
      const saved = fs.readFileSync(tmpFile)
      const f07 = await js(`return { dirty: T.dirty(), toast: !!document.querySelector('.toast.show'), title: document.title }`)
      check('AC-F07', 'Ctrl+S 直接覆盖保存，提示「已保存」，圆点消失',
        dirtyBefore && saved.toString('utf8').includes('保存校验ABC') && !f07.dirty && f07.toast, { dirtyBefore, ...f07 })
      check('AC-F13', '保存为 UTF-8 无 BOM', !(saved[0] === 0xef && saved[1] === 0xbb && saved[2] === 0xbf) && saved.toString('utf8').includes('键盘测试'), saved.slice(0, 3))
      check('AC-F18', '文件名含空格/中文/括号时打开、保存、标题显示正常', f07.title.startsWith('保存 测试 (1).md'), f07.title)

      // AC-F14 带 BOM 的文件
      const bomFile = path.join(tmpDir, 'bom.md')
      fs.writeFileSync(bomFile, '﻿# BOM 文件\n\n内容\n', 'utf8')
      const bomDoc = await js(`const d = await window.api.readFile(${JSON.stringify(bomFile)}); window.__test.loadDoc(d); await T.sleep(300); return { first: d.content.charCodeAt(0), h1: document.querySelector('.prose h1')?.textContent }`)
      check('AC-F14', '带 BOM 的文件正常显示，开头无多余字符', bomDoc.first === 35 && bomDoc.h1 === 'BOM 文件', bomDoc)

      // AC-S02 文件中的脚本不执行
      const s02 = await js(`
        window.__pwned = 0
        window.__test.loadDoc({ path: null, name: 'xss.md', content: '# 安全\\n\\n<script>window.__pwned = 1</script>\\n\\n<img src="x" onerror="window.__pwned = 2">\\n\\n[点我](javascript:window.__pwned=3)\\n' })
        await T.sleep(600)
        document.querySelector('.prose a')?.click()
        await T.sleep(200)
        return { pwned: window.__pwned, scripts: document.querySelectorAll('.prose script').length }`)
      // 安全策略拦截恶意脚本时会输出控制台记录：作为 AC-S02 的证据，不计入 AC-P06
      await wait(200)
      const cspBlocked = consoleErrors.filter((m) => /Content Security Policy/.test(m)).length
      for (let i = consoleErrors.length - 1; i >= 0; i--) if (/Content Security Policy/.test(consoleErrors[i])) consoleErrors.splice(i, 1)
      check('AC-S02', '文件中的 <script>、onerror、javascript: 链接都不执行', s02.pwned === 0 && s02.scripts === 0, { ...s02, cspBlocked })

      // AC-E08 链接弹窗：添加 → 编辑 → 清空即移除；未选中时可输入显示文字
      await js(`window.__test.loadDoc({ path: null, name: '链接.md', content: '链接测试文字\\n' }); await T.sleep(300); return true`)
      const fillModal = async (values) => {
        await js(`
          const ins = document.querySelectorAll('.modal input')
          const vals = ${JSON.stringify(values)}
          if (ins.length < vals.length) throw new Error('弹窗只有 ' + ins.length + ' 个输入框，需要 ' + vals.length + ' 个；选区 ' + JSON.stringify([T.e().state.selection.from, T.e().state.selection.to]) + '，链接属性 ' + JSON.stringify(T.e().getAttributes('link')) + '，文档 ' + JSON.stringify(T.md()))
          vals.forEach((v, i) => { ins[i].value = v })
          document.querySelector('.modal button[type=submit]').click()
          await T.sleep(250); return true`)
      }
      const e08 = {}
      await js(`T.select('链接测试'); return true`)
      await key('K', ['control'])
      e08.modalFields = await js(`return document.querySelectorAll('.modal input').length`)
      e08.before = await js(`return { sel: [T.e().state.selection.from, T.e().state.selection.to], modals: document.querySelectorAll('.modal-mask').length, leaving: document.querySelectorAll('.modal-mask.leaving').length, title: document.querySelector('.modal-mask:not(.leaving) .modal-title')?.textContent || null, focused: document.activeElement?.tagName }`)
      await fillModal(['https://example.com'])
      e08.added = await js(`return T.md().includes('[链接测试](https://example.com)')`)
      if (!e08.added) e08.addedState = await js(`await T.sleep(300); return { md: T.md(), sel: [T.e().state.selection.from, T.e().state.selection.to], modals: document.querySelectorAll('.modal-mask').length, mode: window.__test.state.mode }`)
      await js(`const p = T.findText('链接测试'); T.e().commands.setTextSelection(p + 1); return true`)
      await key('K', ['control'])
      e08.prefilled = await js(`return document.querySelector('.modal input').value`)
      await fillModal(['https://example.org'])
      e08.edited = await js(`return T.md().includes('[链接测试](https://example.org)')`)
      await js(`const p = T.findText('链接测试'); T.e().commands.setTextSelection(p + 1); return true`)
      await key('K', ['control'])
      await fillModal([''])
      e08.removed = await js(`return !T.md().includes('](') && T.md().includes('链接测试文字')`)
      await js(`T.e().commands.focus('end'); return true`)
      await key('K', ['control'])
      e08.twoFields = await js(`return document.querySelectorAll('.modal input').length === 2`)
      await fillModal(['https://a.cn', '新链接'])
      e08.insertedWithText = await js(`return T.md().includes('[新链接](https://a.cn)')`)
      check('AC-E08', '链接：添加、带出原地址编辑、清空移除、无选区时可填显示文字',
        e08.modalFields === 1 && e08.added && e08.prefilled === 'https://example.com' && e08.edited && e08.removed && e08.twoFields && e08.insertedWithText, e08)

      // 视图快捷键（菜单加速键在隐藏标题栏下是否有效）
      win.webContents.focus()
      const views = {}
      await menuKey('CmdOrCtrl+/')
      views['源码 Ctrl+/'] = await js(`return document.body.dataset.mode === 'source'`)
      await menuKey('CmdOrCtrl+/')
      await menuKey('CmdOrCtrl+R')
      views['阅读 Ctrl+R'] = await js(`return document.body.dataset.mode === 'read'`)
      await menuKey('CmdOrCtrl+R')
      await menuKey('CmdOrCtrl+\\')
      views['大纲 Ctrl+\\'] = await js(`return document.body.classList.contains('no-outline')`)
      await menuKey('CmdOrCtrl+\\')
      check('AC-D05', '视图快捷键（菜单加速键）在统一标题栏下有效', Object.values(views).every(Boolean), { ...views, 触发方式: [...new Set(menuPaths.filter((p) => /[/R\\]$|[/R\\] /.test(p)))] })

      // =================== M2：兼容、草稿、阅读、视觉 ===================
      const reload = async ({ crash = false, wc = win.webContents } = {}) => {
        if (crash) wc.forcefullyCrashRenderer()
        await wait(300)
        await new Promise((r) => {
          wc.once('did-finish-load', r)
          wc.reload()
        })
        await wait(1500)
        await injectT(wc)
      }
      const loadFile = async (p) => {
        await js(`const d = await window.api.readFile(${JSON.stringify(p)}); window.__test.loadDoc(d); await T.sleep(500); return true`)
      }
      // 草稿文件在主进程里按 sha1(键名) 命名，直接看磁盘更可靠（「丢弃」是异步删除）
      const crypto = require('node:crypto')
      const draftPathOf = (key) => path.join(outDir, 'userdata', 'drafts', crypto.createHash('sha1').update(key).digest('hex') + '.json')
      const waitDraftGone = async (key, ms = 2000) => {
        const f = draftPathOf(key)
        for (let t = 0; t < ms && fs.existsSync(f); t += 100) await wait(100)
        return !fs.existsSync(f)
      }
      const draftsOnDisk = () => {
        const dir = path.join(outDir, 'userdata', 'drafts')
        try {
          return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
            try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { key: d.key, time: d.time } } catch { return { key: f } }
          })
        } catch { return [] }
      }

      // AC-M04 / M05 / M06 第三方写法、HTML 片段、代码块内容
      const compatIn = fs.readFileSync(path.join(__dirname, '..', 'samples', '兼容性.md'), 'utf8')
      const compat = await js(`
        window.__test.loadDoc({ path: null, name: '兼容性.md', content: ${JSON.stringify(compatIn)} }); await T.sleep(400)
        const out = T.md()
        window.__test.loadDoc({ path: null, name: '兼容性.md', content: out }); await T.sleep(300)
        return { out, again: T.md(), htmlBlocks: document.querySelectorAll('.prose .html-block').length,
          sub: !!document.querySelector('.prose sub'), sup: !!document.querySelector('.prose sup'), kbd: !!document.querySelector('.prose kbd'),
          ul: document.querySelectorAll('.prose ul > li').length, ol: document.querySelectorAll('.prose ol > li').length,
          strong: [...document.querySelectorAll('.prose strong')].some(e => e.textContent === '双下划线粗体'),
          em: [...document.querySelectorAll('.prose em')].some(e => e.textContent === '单下划线斜体') }`)
      // 改动过的块才会重新生成：把整篇内容重新生成一遍（相当于全部改动），检查规范化写法
      const compatEdited = await js(`
        window.__test.loadDoc({ path: null, name: '兼容性.md', content: ${JSON.stringify(compatIn)} }); await T.sleep(300)
        return T.e().storage.markdown.getMarkdownPlain()`)
      const has = (t) => compat.out.includes(t)
      const norm = (t) => t.replace(/\r\n/g, '\n').trim()
      const hasE = (t) => compatEdited.includes(t)
      check('AC-M04', '第三方写法（* 列表、__粗体__、1) 编号）正确显示；未改动时原样保存，改动后规范化为本应用写法且内容不丢',
        compat.ul >= 2 && compat.ol === 2 && compat.strong && compat.em && norm(compat.out) === norm(compatIn) &&
          hasE('- 星号列表') && hasE('1. 括号编号') && hasE('**双下划线粗体**') && hasE('*单下划线斜体*'),
        { ul: compat.ul, ol: compat.ol, strong: compat.strong, em: compat.em, same: norm(compat.out) === norm(compatIn), edited: compatEdited.slice(0, 160) })
      check('AC-M05', 'HTML 片段原样保留：<br> <sub> <sup> <kbd> <span> 注释 <details> <div align>',
        has('第一行<br>第二行') && hasE('第一行<br>第二行') && hasE('H<sub>2</sub>O') && hasE('<span style="color:red">红字</span>') && has('H<sub>2</sub>O') && has('x<sup>2</sup>') && has('<kbd>Ctrl</kbd>') && has('<span style="color:red">红字</span>') &&
          has('<!-- 注释 -->') && has('<details>\n<summary>展开</summary>') && has('</details>') && has('<div align="center">\n  <img src="x.png" width="100">\n</div>') &&
          compat.htmlBlocks === 4 && compat.sub && compat.sup && compat.kbd,
        { htmlBlocks: compat.htmlBlocks })
      check('AC-M06', '代码块内容（**、#、<tag>、制表符、空格缩进）原样不变', has('```\n**不是粗体** # 不是标题 <tag>\n\t制表符缩进\n    四空格\n```'), null)
      check('AC-M02b', '规范化后再次打开保存，结果完全一致（稳定）', compat.out === compat.again, null)

      // AC-M03 工具栏生成的语法（表格为 GFM）
      const m03 = await js(`
        window.__test.loadDoc({ path: null, name: 't.md', content: '' }); await T.sleep(200)
        T.click('#toolbar [data-cmd=table]'); await T.sleep(100)
        T.e().commands.insertContent('甲'); await T.sleep(100)
        return T.md()`)
      check('AC-M03', '格式栏生成标准语法（表格为 GFM；文字样式见 AC-E02，代码块见 AC-E07）', /\| 甲 \|.*\n\| --- \| --- \| --- \|/.test(m03), m03.slice(0, 120))

      // AC-E14 插入图片：同目录 → 相对路径；其他位置 → 绝对路径；网络地址
      const imgDir = path.join(tmpDir, 'img')
      fs.mkdirSync(imgDir, { recursive: true })
      fs.copyFileSync(path.join(__dirname, '..', 'samples', 'img', 'sample.svg'), path.join(imgDir, '图 1.svg'))
      const imgDoc = path.join(tmpDir, '图片测试.md')
      fs.writeFileSync(imgDoc, '# 图片\n', 'utf8')
      await loadFile(imgDoc)
      const insertImage = async (pick, typed) => {
        fake.openAnswer = pick
        await js(`T.e().commands.focus('end'); T.click('#toolbar [data-cmd=image]'); await T.sleep(300); return true`)
        if (pick) await js(`document.querySelector('.modal [data-act=extra]').click(); await T.sleep(300); return true`)
        const val = await js(`
          const i = document.querySelector('.modal input'); ${typed ? `i.value = ${JSON.stringify(typed)};` : ''}
          const v = i.value; document.querySelector('.modal button[type=submit]').click(); await T.sleep(600); return v`)
        fake.openAnswer = null
        return val
      }
      const e14 = {}
      e14.relValue = await insertImage(path.join(imgDir, '图 1.svg'))
      e14.absValue = await insertImage(path.join(__dirname, '..', 'samples', 'img', 'sample.svg'))
      await insertImage(null, 'https://example.com/a.png')
      const e14r = await js(`
        const imgs = [...document.querySelectorAll('.prose img:not(.ProseMirror-separator)')]
        return { md: T.md(), loaded: imgs.map(i => i.complete && i.naturalWidth > 0) }`)
      e14.relSaved = e14r.md.includes('![](<img/图 1.svg>)') // 路径保持原文；含空格时用 <地址>
      e14.absSaved = e14r.md.includes('![](D:/markdown_app/samples/img/sample.svg)')
      e14.urlSaved = e14r.md.includes('![](https://example.com/a.png)')
      e14.localLoaded = e14r.loaded[0] && e14r.loaded[1]
      check('AC-E14', '插入图片：同目录用相对路径、其他位置用绝对路径、网络地址；本地图片能显示',
        e14.relValue === 'img/图 1.svg' && e14.relSaved && e14.absSaved && e14.urlSaved && e14.localLoaded, { ...e14, md: e14r.md })

      // AC-E15 粘贴 Markdown 文本、网页内容（派发真实的 paste 事件，不动系统剪贴板）
      const paste = (data) =>
        js(`
          const dt = new DataTransfer()
          const data = ${JSON.stringify(data)}
          for (const k in data) dt.setData(k, data[k])
          T.e().view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
          await T.sleep(300); return true`)
      await js(`window.__test.loadDoc({ path: null, name: 'p.md', content: '起始\\n' }); await T.sleep(200); T.e().commands.focus('end'); return true`)
      await js(`T.e().chain().focus('end').insertContent({type:'paragraph'}).run(); return true`)
      await paste({ 'text/plain': '## 粘贴标题\n\n- 甲\n- 乙\n\n**粗体**' })
      const e15a = await js(`return { h2: !!document.querySelector('.prose h2'), li: document.querySelectorAll('.prose ul li').length, b: !!document.querySelector('.prose strong') }`)
      await js(`T.e().chain().focus('end').insertContent({type:'paragraph'}).run(); return true`)
      await paste({ 'text/plain': '网页标题 粗 链 项', 'text/html': '<h3>网页标题</h3><p><strong>粗</strong> <a href="https://x.com">链</a></p><ol><li>项</li></ol>' })
      const e15b = await js(`return { h3: !!document.querySelector('.prose h3'), a: !!document.querySelector('.prose a[href="https://x.com"]'), ol: !!document.querySelector('.prose ol li') }`)
      check('AC-E15', '粘贴 Markdown 自动转格式；粘贴网页内容保留标题、粗体、列表、链接',
        e15a.h2 && e15a.li === 2 && e15a.b && e15b.h3 && e15b.a && e15b.ol, { e15a, e15b })

      // AC-E16 清除格式（右键菜单命令）
      const e16 = await js(`
        window.__test.loadDoc({ path: null, name: 'c.md', content: '## **粗体标题**\\n' }); await T.sleep(200)
        T.e().commands.selectAll(); return true`)
      win.webContents.send('menu', 'clearFormat')
      await wait(200)
      const e16r = await js(`return T.md().trim()`)
      check('AC-E16', '清除格式移除文字样式并恢复为正文', e16r === '粗体标题', e16r)

      // AC-F15 草稿写入磁盘；渲染进程崩溃后重新打开同一文件可恢复
      const draftDoc = path.join(tmpDir, '草稿测试.md')
      fs.writeFileSync(draftDoc, '# 草稿\n\n原文\n', 'utf8')
      await loadFile(draftDoc)
      await js(`T.e().chain().focus('end').insertContent('崩溃前的修改').run(); return true`)
      await wait(700)
      const draftFiles = fs.readdirSync(path.join(outDir, 'userdata', 'drafts')).filter((f) => f.endsWith('.json'))
      await reload({ crash: true })
      await loadFile(draftDoc)
      const f15 = await js(`
        for (let i = 0; i < 15 && !document.querySelector('.draft-banner'); i++) await T.sleep(100)
        const bar = document.querySelector('.draft-banner')
        const text = bar && bar.textContent
        bar?.querySelector('[data-a=restore]').click(); await T.sleep(500)
        return { banner: !!bar, text, restored: T.md().includes('崩溃前的修改'), dirty: T.dirty(), file: ${JSON.stringify(draftDoc)} }`)
      // 丢弃后不再出现
      await js(`window.__test.loadDoc({ path: null, name: 'x.md', content: '' }); await T.sleep(300); return true`)
      await loadFile(draftDoc)
      // 草稿提示条在读取草稿后才出现：等它出现再点，避免点空导致草稿没被清掉
      const f15b = await js(`
        for (let i = 0; i < 15 && !document.querySelector('.draft-banner'); i++) await T.sleep(100)
        const bar = document.querySelector('.draft-banner')
        if (!bar) return false
        bar.querySelector('[data-a=drop]').click(); await T.sleep(300)
        return !document.querySelector('.draft-banner')`)
      // 界面上的提示条先消失，磁盘上的草稿是异步删的：以磁盘为准
      const f15bGone = await waitDraftGone('draft:' + draftDoc)
      await js(`window.__test.loadDoc({ path: null, name: 'x.md', content: '' }); await T.sleep(300); return true`)
      await loadFile(draftDoc)
      // 留出时间：如果草稿没清干净，提示条会在这段时间里重新出现
      const f15c = await js(`
        for (let i = 0; i < 12; i++) { await T.sleep(150); if (document.querySelector('.draft-banner')) return false }
        return true`)
      const f15cGone = await waitDraftGone('draft:' + draftDoc, 300)
      check('AC-F15', '强制崩溃后重开同一文件：出现草稿提示，恢复后内容回来且为未保存；丢弃后不再出现',
        draftFiles.length > 0 && f15.banner && f15.restored && f15.dirty && f15b && f15bGone && f15c && f15cGone,
        { draftFiles: draftFiles.length, ...f15, noBannerAfterDrop: f15c, draftGoneOnDisk: f15bGone && f15cGone, drafts: draftsOnDisk() })

      // AC-F17 保存到只读文件 → 错误对话框，内容保留、未保存标记不消失
      const roFile = path.join(tmpDir, '只读.md')
      fs.writeFileSync(roFile, '# 只读\n', 'utf8')
      fs.chmodSync(roFile, 0o444)
      await loadFile(roFile)
      await js(`T.e().chain().focus('end').insertContent('改动').run(); await T.sleep(400); return true`)
      fake.box = []
      fake.boxAnswer = 0
      await menuKey('CmdOrCtrl+S')
      await wait(600)
      const f17 = await js(`return { dirty: T.dirty(), kept: T.md().includes('改动') }`)
      const f17open = await js(`return await window.api.readFile(${JSON.stringify(path.join(tmpDir, '不存在.md'))})`)
      fs.chmodSync(roFile, 0o666)
      check('AC-F17', '保存到只读文件弹出错误对话框说明原因，内容保留，未保存标记不消失；打开失败同样提示',
        fake.box[0] === '无法保存“只读.md”' && f17.dirty && f17.kept && f17open.error && fake.box[1] === '无法打开“不存在.md”', { box: fake.box, ...f17 })
      await js(`window.__test.loadDoc({ path: null, name: 'x.md', content: '' }); return true`)

      // AC-R01 点击大纲滚动到对应标题
      await loadFile(mdFile)
      const r01b = await js(`
        const li = [...document.querySelectorAll('#outlineList li')].find(l => l.textContent === '表格')
        li.click(); await T.sleep(900)
        const h = [...document.querySelectorAll('.prose h2')].find(h => h.textContent === '表格')
        const top = h.getBoundingClientRect().top - document.getElementById('paper').getBoundingClientRect().top
        return { top: Math.round(top), current: li.classList.contains('current') }`)
      check('AC-R01b', '点击大纲平滑滚动到标题（标题在格式栏下方可见），并标为当前位置', r01b.top > 40 && r01b.top < 140 && r01b.current, r01b)

      // AC-R02 / R05 大纲收起状态、主题在重启后保持
      await js(`T.click('.titlebar [data-cmd=outline]'); document.documentElement.removeAttribute('data-theme'); window.api.setTheme('system'); return true`)
      await js(`localStorage.setItem('theme', 'dark'); return true`)
      const overlayCalls = []
      const origOverlay = win.setTitleBarOverlay.bind(win)
      win.setTitleBarOverlay = (o) => {
        overlayCalls.push(o)
        return origOverlay(o)
      }
      await reload()
      const r02 = await js(`return { hidden: document.body.classList.contains('no-outline'), theme: document.documentElement.dataset.theme }`)
      check('AC-R02', '大纲收起状态在重启后保持', r02.hidden, r02)
      check('AC-R05b', '主题在重启后保持，窗口按钮颜色跟随深色', r02.theme === 'dark' && overlayCalls.some((o) => o.symbolColor === '#f5f5f7'), { ...r02, overlayCalls })
      await js(`T.click('.titlebar [data-cmd=outline]'); localStorage.removeItem('theme'); document.documentElement.removeAttribute('data-theme'); window.api.setTheme('system'); return true`)
      win.setTitleBarOverlay = origOverlay

      // AC-R04 / R07 链接：阅读模式单击打开；编辑模式普通单击不打开、Ctrl+单击打开；应用内永远不跳转
      await js(`window.__test.loadDoc({ path: null, name: 'l.md', content: '[苹果](https://www.apple.com)\\n' }); await T.sleep(300); return true`)
      fake.external = []
      const linkBox = await js(`const r = document.querySelector('.prose a').getBoundingClientRect(); return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) }`)
      const clickAt = async (mods = []) => {
        win.focus()
        win.webContents.sendInputEvent({ type: 'mouseDown', x: linkBox.x, y: linkBox.y, button: 'left', clickCount: 1, modifiers: mods })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: linkBox.x, y: linkBox.y, button: 'left', clickCount: 1, modifiers: mods })
        await wait(300)
      }
      await clickAt()
      const plain = fake.external.length
      await clickAt(['control'])
      const ctrl = fake.external.length
      await js(`T.click('.mode-switch .seg-item[data-value=read]'); await T.sleep(300); return true`)
      // 阅读模式隐藏格式栏后链接位置会上移，重新取坐标
      Object.assign(linkBox, await js(`const r = document.querySelector('.prose a').getBoundingClientRect(); return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) }`))
      await clickAt()
      const read = fake.external.length
      await js(`T.click('.mode-switch .seg-item[data-value=edit]'); await T.sleep(200); return true`)
      const urlBefore = win.webContents.getURL()
      await js(`location.href = 'https://example.com/'; return true`).catch(() => {})
      await wait(800)
      const stayed = win.webContents.getURL() === urlBefore
      check('AC-R07', '编辑模式普通单击不打开、Ctrl+单击用系统浏览器打开；应用内不会跳转网页',
        plain === 0 && ctrl === 1 && stayed && fake.external[0] === 'https://www.apple.com', { plain, ctrl, stayed, external: fake.external })
      check('AC-R04b', '阅读模式单击链接用系统浏览器打开', read === 2, { read })

      // AC-S01 渲染进程没有 Node 权限；AC-S03 本地图片通道只允许图片
      const s01 = await js(`return { require: typeof require, process: typeof process, module: typeof module }`)
      check('AC-S01', '渲染进程无法访问 Node.js（沙箱 + 上下文隔离）', s01.require === 'undefined' && s01.process === 'undefined', s01)
      const s03 = await js(`
        const f = (p) => new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('blocked'); i.src = 'localfile://file?path=' + encodeURIComponent(p) })
        return { pkg: await f(${JSON.stringify(path.join(__dirname, '..', 'package.json'))}), svg: await f(${JSON.stringify(path.join(__dirname, '..', 'samples', 'img', 'sample.svg'))}) }`)
      check('AC-S03', '本地图片通道只允许读取图片类型文件', s03.pkg === 'blocked' && s03.svg === 'loaded', s03)

      // AC-V03 最小窗口：格式栏换行、无横向滚动、无重叠
      await loadFile(mdFile)
      const origBounds = win.getBounds()
      win.setSize(680, 460)
      await wait(600)
      const v03 = await js(`
        const doc = document.documentElement, sc = document.getElementById('paper'), fb = document.getElementById('toolbar').getBoundingClientRect()
        const c = document.getElementById('docName').getBoundingClientRect(), l = document.querySelector('.titlebar-side.left button:last-child').getBoundingClientRect(), r = document.querySelector('.titlebar-side.right > :first-child').getBoundingClientRect()
        return { w: innerWidth, docOverflow: doc.scrollWidth > doc.clientWidth, paperOverflow: sc.scrollWidth > sc.clientWidth,
          barInside: fb.left >= 0 && fb.right <= innerWidth, barRows: Math.round(fb.height / 44), titleOverlap: c.left < l.right || c.right > r.left }`)
      await shot('07-最小窗口')
      win.setBounds(origBounds)
      await wait(400)
      check('AC-V03', '最小尺寸 680×460：格式栏换行、无横向滚动、标题栏无重叠', !v03.docOverflow && !v03.paperOverflow && v03.barInside && !v03.titleOverlap, v03)

      // AC-V04 缩放 80% / 150% / 200%
      const v04 = {}
      for (const z of [0.8, 1.5, 2]) {
        win.webContents.setZoomFactor(z)
        await wait(500)
        v04[z] = await js(`
          const doc = document.documentElement, sc = document.getElementById('paper'), fb = document.getElementById('toolbar').getBoundingClientRect()
          const c = document.getElementById('docName').getBoundingClientRect(), l = document.querySelector('.titlebar-side.left button:last-child').getBoundingClientRect(), r = document.querySelector('.titlebar-side.right > :first-child').getBoundingClientRect()
          return { overflow: doc.scrollWidth > doc.clientWidth || sc.scrollWidth > sc.clientWidth, barInside: fb.left >= 0 && fb.right <= innerWidth, titleOverlap: c.left < l.right - 1 || c.right > r.left + 1 }`)
        await shot('08-缩放' + Math.round(z * 100))
      }
      win.webContents.setZoomFactor(1)
      check('AC-V04', '界面缩放 80% / 150% / 200% 布局正常', Object.values(v04).every((v) => !v.overflow && v.barInside && !v.titleOverlap), v04)

      // AC-V08 / V09 动效时长与「减少动态效果 / 减少透明度」
      const dbg = win.webContents.debugger
      dbg.attach('1.3')
      const motion = () => js(`
        const b = getComputedStyle(document.querySelector('.fmt-btn'))
        const s = getComputedStyle(document.querySelector('.sidebar'))
        const f = getComputedStyle(document.getElementById('toolbar'))
        return { btn: b.transitionDuration, sidebar: s.transitionDuration, backdrop: f.backdropFilter, bg: f.backgroundColor }`)
      const normal = await motion()
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      const reduced = await motion()
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
      const opaque = await motion()
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      dbg.detach()
      check('AC-V09', '动效时长符合规范（按钮 150ms、侧栏 250ms），减少动态效果时几乎为 0',
        normal.btn.startsWith('0.15s') && normal.sidebar.startsWith('0.25s') && reduced.btn.startsWith('0.001s'), { normal, reduced })
      check('AC-V08', '减少透明度时浮层改为实色、去掉背景模糊', normal.backdrop !== 'none' && opaque.backdrop === 'none' && !/rgba\(.*0\.86\)/.test(opaque.bg), { normal: normal.backdrop, opaque })

      // AC-V05 界面文案术语
      const srcText = ['index.html', 'src/main.js', 'src/toolbar.js', 'src/ui.js', 'src/editor.js', 'electron/main.cjs']
        .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, ''))
        .join('\n')
      const banned = ['待办', 'Todo', '任务列表', 'TOC', '目录', '预览模式', '源代码视图', '荧光笔', '代码片段', '内联代码', '一级标题', '您', '！']
      const hits = banned.filter((w) => srcText.includes(w))
      check('AC-V05', '界面文案不含术语表中的禁用词', hits.length === 0, hits)

      // AC-V06b 圆角刻度（v1.4 方案 A · 圆润）：设计变量与实际组件
      const v06b = await js(`
        window.__test.loadDoc({ path: null, name: 'r.md', content: '# 圆角\\n\\n\`\`\`\\ncode\\n\`\`\`\\n' }); await T.sleep(300)
        const cs = getComputedStyle(document.documentElement)
        const tokens = ['xs', 'sm', 'md', 'lg', 'xl'].map((k) => cs.getPropertyValue('--r-' + k).trim())
        const probe = (cls, parent = document.body) => { const el = document.createElement('div'); el.className = cls; parent.appendChild(el); const s = getComputedStyle(el); const r = { radius: s.borderTopLeftRadius, padding: s.paddingTop }; el.remove(); return r }
        const pop = probe('popover'), popItem = probe('pop-item')
        return { tokens, sheet: getComputedStyle(document.querySelector('.sheet')).borderTopLeftRadius,
          pre: getComputedStyle(document.querySelector('.prose pre')).borderTopLeftRadius,
          outline: getComputedStyle(document.querySelector('#outlineList li') || document.body).borderTopLeftRadius,
          fileItem: probe('file-item').radius, pager: probe('pager-card').radius, modal: probe('modal').radius, pop, popItem }`)
      const px = (v) => parseFloat(v)
      check('AC-V06b', '圆角刻度 6/12/16/20/28：纸面 16、代码块 16、侧栏条目 12、下拉面板 20 且选项 12（同心）、翻页卡片 20、弹窗 28',
        v06b.tokens.join(',') === '6px,12px,16px,20px,28px' && v06b.sheet === '16px' && v06b.pre === '16px' && v06b.outline === '12px' && v06b.fileItem === '12px' &&
          v06b.pop.radius === '20px' && px(v06b.pop.radius) - px(v06b.pop.padding) === px(v06b.popItem.radius) && v06b.pager === '20px' && v06b.modal === '28px',
        v06b)

      // =================== M2.5：连续写作、阅读记忆、编辑/阅读滑块 ===================
      const serialSrc = path.join(__dirname, '..', 'samples', '连载')
      const serial = path.join(tmpDir, '连载')
      fs.cpSync(serialSrc, serial, { recursive: true })
      const P = (n) => path.join(serial, n)
      const cur = () => js(`return { path: window.__test.state.path, mode: window.__test.state.mode, dirty: T.dirty(), name: document.getElementById('docName').textContent }`)
      const waitFor = async (fn, ms = 3000) => {
        const t0 = Date.now()
        while (Date.now() - t0 < ms) {
          if (await fn()) return Date.now() - t0
          await wait(50)
        }
        return -1
      }
      const listNames = () => js(`return [...document.querySelectorAll('#filesList .file-item')].map(li => ({ name: li.title, current: li.classList.contains('current'), dot: !!li.querySelector('.file-dot') }))`)
      const clickSel = (sel) => js(`T.click(${JSON.stringify(sel)}); await T.sleep(500); return true`)
      fake.boxAnswer = 1
      await js(`window.__test.loadDoc({}); return true`)

      // AC-N01 / N02 / N03 自动识别篇目、排序、默认显示篇目
      await loadFile(P('02-第二章.md'))
      await wait(400)
      let names = await listNames()
      const side0 = await js(`return { side: document.body.dataset.side, seg: document.querySelector('#sideSlot .segmented').dataset.value }`)
      check('AC-N01', '打开一篇后列出同文件夹的 4 篇 Markdown（子文件夹默认收起），不含 .txt，当前篇高亮',
        names.length === 4 && names.find((n) => n.current)?.name === '02-第二章.md', names)
      const order02 = await js(`return [...document.querySelectorAll('#filesList > li')].map(li => (li.classList.contains('folder-item') ? '/' : '') + li.title).join(',')`)
      check('AC-N02', '篇目每一层先列文件夹、再列文章，两者各自按名称自然排序：第一卷、子文件夹，然后 01、02、10、附录',
        names.map((n) => n.name).join(',') === '01-开篇.md,02-第二章.md,10-第十章.md,附录.md' && order02 === '/第一卷,/子文件夹,01-开篇.md,02-第二章.md,10-第十章.md,附录.md', order02)

      // AC-N04 点击篇目打开
      await clickSel('#filesList .file-item[title="10-第十章.md"]')
      let c = await cur()
      names = await listNames()
      check('AC-N04', '点击篇目在当前窗口打开，高亮和文件名随之更新', c.path === P('10-第十章.md') && c.name === '10-第十章.md' && names.find((n) => n.current)?.name === '10-第十章.md', c)

      // AC-N05 上一篇 / 下一篇卡片
      const pager = () => js(`const pg = document.getElementById('pager'); return { hidden: pg.hidden, prev: pg.querySelector('.prev .pager-title')?.textContent || null, next: pg.querySelector('.next .pager-title')?.textContent || null }`)
      const pMid = await pager()
      await clickSel('#pager .next')
      const afterNext = await cur()
      const pLast = await pager()
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(400); return true`)
      const pFirst = await pager()
      const mdHasPager = await js(`return T.md().trim() !== window.__test.state.savedMd.trim() || /‹ 上一篇|下一篇 ›/.test(T.md())`) // 卡片内容不能混进文档
      check('AC-N05', '正文末尾显示上一篇/下一篇及篇名；首篇只有下一篇、末篇只有上一篇；可点击跳转；不写入文件',
        pMid.prev === '第二章' && pMid.next === '附录' && afterNext.path === P('附录.md') && pLast.prev === '第十章' && pLast.next === null &&
          pFirst.prev === null && pFirst.next === '第二章' && !mdHasPager, { pMid, pLast, pFirst, mdHasPager })

      // AC-N23 卡片固定在窗口底部：文首 / 文中 / 文末位置相同；不挡滚动条；最后一行在卡片上方；在底部输入时光标不被挡住
      const longMd = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：用来测试上一篇和下一篇卡片固定在窗口底部时的滚动与输入。`).join('\n\n')
      await js(`window.__test.loadDoc({ path: ${JSON.stringify(P('02-第二章.md'))}, name: '02-第二章.md', content: ${JSON.stringify(longMd)} }); await T.sleep(500); return true`)
      const pagerBox = () => js(`
        const pg = document.getElementById('pager'), card = pg.querySelector('.pager-card'), paper = document.getElementById('paper'), sheet = document.querySelector('.sheet')
        const r = card.getBoundingClientRect(), s = sheet.getBoundingClientRect(), pr = pg.getBoundingClientRect(), st = document.getElementById('stats').getBoundingClientRect()
        return { cardTop: Math.round(r.top), cardBottom: Math.round(r.bottom), sheetBottom: Math.round(s.bottom), pagerRight: Math.round(pr.right),
          contentRight: Math.round(s.left + paper.clientWidth), statsBottom: Math.round(st.bottom), statsH: Math.round(st.height), hidden: pg.hidden }`)
      const n23 = {}
      await js(`document.getElementById('paper').scrollTop = 0; await T.sleep(150); return true`)
      n23.top = await pagerBox()
      await js(`const p = document.getElementById('paper'); p.scrollTop = p.scrollHeight / 2; await T.sleep(150); return true`)
      n23.mid = await pagerBox()
      await js(`const p = document.getElementById('paper'); p.scrollTop = p.scrollHeight; await T.sleep(200); return true`)
      n23.end = await pagerBox()
      n23.lastBottom = await js(`const ps = document.querySelectorAll('.prose p'); return Math.round(ps[ps.length - 1].getBoundingClientRect().bottom)`)
      // 光标放在窗口最底部那一段的末尾，用真实按键连续换行输入
      await js(`document.getElementById('paper').scrollTop = 0; await T.sleep(150)
        const cardTop = document.querySelector('#pager .pager-card').getBoundingClientRect().top
        const p = [...document.querySelectorAll('.prose p')].find(p => p.getBoundingClientRect().bottom > cardTop)
        const pos = T.e().view.posAtDOM(p, 0) + p.textContent.length
        T.e().commands.focus(); T.e().commands.setTextSelection(pos); await T.sleep(100); return true`)
      for (let i = 0; i < 4; i++) {
        await key('Return')
        await type('底部输入')
      }
      await wait(300)
      n23.caret = await js(`const c = T.e().view.coordsAtPos(T.e().state.selection.from); return { bottom: Math.round(c.bottom), cardTop: Math.round(document.querySelector('#pager .pager-card').getBoundingClientRect().top) }`)
      check('AC-N23', '上一篇/下一篇固定在窗口底部：文首、文中、文末位置相同；不挡滚动条；文末最后一行在卡片上方；底部连续输入时光标不被挡住；字数统计在卡片上方',
        !n23.top.hidden && n23.top.cardTop === n23.mid.cardTop && n23.mid.cardTop === n23.end.cardTop && n23.top.sheetBottom - n23.top.cardBottom === 16 &&
          n23.top.pagerRight <= n23.top.contentRight && n23.lastBottom <= n23.end.cardTop && n23.caret.bottom <= n23.caret.cardTop &&
          n23.top.statsBottom <= n23.top.cardTop - 24,
        n23)
      await wait(400) // 等草稿写完再清掉，避免后面打开第二章时出现草稿提示
      await js(`const d = await window.api.readFile(${JSON.stringify(P('01-开篇.md'))}); window.__test.loadDoc(d); await T.sleep(400)
        window.api.clearDraft('draft:' + ${JSON.stringify(P('02-第二章.md'))}); await T.sleep(100); return true`)

      // AC-N24 翻页动效：往后翻粒子 + 从右侧滑入；往前翻从左侧滑入；结束后不留覆盖层；打开文件 / 文件夹不播放
      const turnInfo = () => js(`
        await T.sleep(1300)
        const s = window.__test.pageTurn.stats, l = s.last, e = getComputedStyle(document.getElementById('editor'))
        return { runs: s.runs, last: l && { dir: l.dir, particles: l.particles, startMs: l.startMs, captureMs: l.captureMs, slideFrom: l.slideFrom, fps: l.fps, reduced: l.reduced },
          canvases: document.querySelectorAll('.page-turn-canvas').length, transform: e.transform, opacity: e.opacity, path: window.__test.state.path }`)
      const sawCanvas = () => js(`for (let i = 0; i < 40; i++) { if (document.querySelector('.page-turn-canvas')) return true; await T.sleep(10) } return false`)
      await js(`T.click('#pager .next'); return true`)
      const n24 = { canvasNext: await sawCanvas(), next: await turnInfo() }
      await menuKey('CmdOrCtrl+[')
      n24.canvasPrev = await sawCanvas()
      n24.prev = await turnInfo()
      const runsBefore = n24.prev.runs
      await loadFile(P('附录.md'))
      await js(`await window.__test.openFolder(${JSON.stringify(serial)}); await T.sleep(400); return true`)
      n24.runsAfterOpen = await js(`return window.__test.pageTurn.stats.runs`)
      const settled = (r) => r.canvases === 0 && (r.transform === 'none' || r.transform === 'matrix(1, 0, 0, 1, 0, 0)') && r.opacity === '1'
      check('AC-N24', '翻页动效：往后翻出现粒子层并从右侧滑入、往前翻从左侧滑入；粒子在 100ms 内开始；结束后无覆盖层、正文复位；打开文件或文件夹时不播放',
        n24.canvasNext && n24.next.last.dir === 1 && n24.next.last.particles > 0 && n24.next.last.startMs <= 100 && n24.next.last.slideFrom === 48 && n24.next.path === P('02-第二章.md') && settled(n24.next) &&
          n24.canvasPrev && n24.prev.last.dir === -1 && n24.prev.last.slideFrom === -48 && n24.prev.path === P('01-开篇.md') && settled(n24.prev) && n24.runsAfterOpen === runsBefore,
        n24)

      // AC-N25 连续快速翻页；减少动态效果时不产生粒子
      await js(`const d = await window.api.readFile(${JSON.stringify(P('01-开篇.md'))}); window.__test.loadDoc(d); await T.sleep(300); return true`)
      for (let i = 0; i < 3; i++) await menuKey('CmdOrCtrl+]')
      await wait(1800)
      const n25 = { rapid: await js(`return { path: window.__test.state.path, canvases: document.querySelectorAll('.page-turn-canvas').length, opacity: getComputedStyle(document.getElementById('editor')).opacity }`) }
      const dbg2 = win.webContents.debugger
      dbg2.attach('1.3')
      await dbg2.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await menuKey('CmdOrCtrl+[')
      n25.reducedCanvas = await sawCanvas()
      n25.reduced = await turnInfo()
      await dbg2.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      dbg2.detach()
      n25.fps = n24.next.last.fps
      check('AC-N25', `连续快速按 3 次 Ctrl+] 停在「附录」且无残留覆盖层；减少动态效果时不产生粒子、只淡入（翻页帧率 ${n24.next.last.fps}fps）`,
        n25.rapid.path === P('附录.md') && n25.rapid.canvases === 0 && n25.rapid.opacity === '1' && !n25.reducedCanvas && n25.reduced.last.reduced && n25.reduced.path === P('10-第十章.md') && settled(n25.reduced),
        n25)

      const sameP = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      // AC-N27 子文件夹树：只列含 Markdown 的文件夹；可折叠；树内跳转根不变；翻页只在同一文件夹内；记住子文件夹里的那一篇；子文件夹变化自动刷新
      await js(`const d = await window.api.readFile(${JSON.stringify(P('02-第二章.md'))}); window.__test.loadDoc(d); await T.sleep(400); return true`)
      const tree = () => js(`return [...document.querySelectorAll('#filesList > li')].map(li => ({ kind: li.classList.contains('folder-item') ? 'dir' : 'file', name: li.title,
        depth: +(li.style.getPropertyValue('--depth') || 0), open: li.classList.contains('open'), current: li.classList.contains('current') }))`)
      const n27 = { initial: await tree() }
      await clickSel('#filesList .folder-item[title="第一卷"]')
      n27.expanded = await tree()
      await clickSel('#filesList .file-item[title="01-起源.md"]')
      await wait(900)
      n27.inVol = { tree: await tree(), root: await js(`return window.__test.folderNav.nav.dir`), pager: await pager(), path: (await cur()).path }
      await menuKey('CmdOrCtrl+]')
      await wait(1300)
      n27.next1 = (await cur()).path
      await menuKey('CmdOrCtrl+]')
      await wait(1300)
      n27.next2 = (await cur()).path // 卷内最后一篇：不跨出文件夹
      await js(`window.__test.loadDoc({}); await T.sleep(200); await window.__test.openFolder(${JSON.stringify(serial)}); await T.sleep(600); return true`)
      n27.reopen = (await cur()).path
      fs.writeFileSync(P('第一卷/03-重逢.md'), '# 重逢\n', 'utf8')
      n27.watchMs = await waitFor(async () => (await tree()).some((t) => t.name === '03-重逢.md'), 3000)
      fs.rmSync(P('第一卷/03-重逢.md'))
      await wait(600)
      const names27 = n27.initial.map((t) => `${t.kind === 'dir' ? '/' : ''}${t.name}`).join(',')
      const vol = n27.expanded.filter((t) => t.depth === 1).map((t) => t.name).join(',')
      check('AC-N27', '子文件夹树：只列含 Markdown 的文件夹且默认收起；展开后文章缩进一层；树内跳转根不变；翻页只在同一文件夹内；重新打开文件夹回到子文件夹里的那一篇；子文件夹新增文章自动出现',
        names27 === '/第一卷,/子文件夹,01-开篇.md,02-第二章.md,10-第十章.md,附录.md' && n27.initial.every((t) => t.kind === 'file' || !t.open) &&
          vol === '01-起源.md,02-相遇.md' && sameP(n27.inVol.root, serial) && n27.inVol.path === P('第一卷/01-起源.md') &&
          n27.inVol.tree.find((t) => t.name === '第一卷')?.open && n27.inVol.tree.find((t) => t.name === '01-起源.md')?.current &&
          n27.inVol.pager.prev === null && n27.inVol.pager.next === '相遇' && n27.next1 === P('第一卷/02-相遇.md') && n27.next2 === P('第一卷/02-相遇.md') &&
          n27.reopen === P('第一卷/02-相遇.md') && n27.watchMs >= 0 && n27.watchMs <= 2000,
        { names27, vol, ...n27, initial: undefined, expanded: undefined })
      await js(`const d = await window.api.readFile(${JSON.stringify(P('01-开篇.md'))}); window.__test.loadDoc(d); await T.sleep(300); return true`)

      // AC-N06 Ctrl+] / Ctrl+[
      await menuKey('CmdOrCtrl+]')
      await wait(500)
      const n06a = (await cur()).path
      await menuKey('CmdOrCtrl+[')
      await wait(500)
      const n06b = (await cur()).path
      await menuKey('CmdOrCtrl+[')
      await wait(500)
      const n06c = (await cur()).path
      check('AC-N06', 'Ctrl+] 下一篇、Ctrl+[ 上一篇；到头不动作', n06a === P('02-第二章.md') && n06b === P('01-开篇.md') && n06c === P('01-开篇.md'), { n06a, n06b, n06c })

      // 点击文中链接：有系统焦点时用真实鼠标，否则向链接派发等价的鼠标事件
      const clickLink = async (text, mods = []) => {
        const box = await js(`const a = [...document.querySelectorAll('.prose a')].find(a => a.textContent === ${JSON.stringify(text)}); a.scrollIntoView({ block: 'center' }); await T.sleep(150); const r = a.getBoundingClientRect(); return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) }`)
        ensureVisible()
        if (!win.isFocused()) {
          win.focus()
          await wait(150)
        }
        if (win.isFocused()) {
          inputStats.real++
          win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: mods })
          win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: mods })
        } else {
          inputStats.synthetic++
          await js(`const a = [...document.querySelectorAll('.prose a')].find(a => a.textContent === ${JSON.stringify(text)})
            const o = { bubbles: true, cancelable: true, clientX: ${box.x}, clientY: ${box.y}, ctrlKey: ${mods.includes('control')}, button: 0 }
            a.dispatchEvent(new MouseEvent('mousedown', o)); a.dispatchEvent(new MouseEvent('mouseup', o)); a.dispatchEvent(new MouseEvent('click', o)); return true`)
        }
        await wait(700)
      }
      const toMode = async (v) => js(`T.click('.mode-switch .seg-item[data-value=${v}]'); await T.sleep(300); return true`)

      // AC-N07 文中链接：编辑模式普通单击不跳、Ctrl+单击跳；阅读模式单击跳
      await clickLink('第二章')
      const n07plain = (await cur()).path
      await clickLink('第二章', ['control'])
      const n07ctrl = (await cur()).path
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(300); return true`)
      await toMode('read')
      await clickLink('第二章')
      const n07read = await cur()
      await toMode('edit')
      check('AC-N07', '文中链接：编辑模式普通单击不跳转、Ctrl+单击打开；阅读模式单击打开',
        n07plain === P('01-开篇.md') && n07ctrl === P('02-第二章.md') && n07read.path === P('02-第二章.md'), { n07plain, n07ctrl, n07read })

      // AC-N08 #标题：跨篇定位、本文定位、百分号编码路径
      const headingTop = (text) => js(`const h = [...document.querySelectorAll('.prose h1,.prose h2,.prose h3')].find(h => h.textContent === ${JSON.stringify(text)}); return h ? Math.round(h.getBoundingClientRect().top - document.getElementById('paper').getBoundingClientRect().top) : null`)
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(300); return true`)
      await clickLink('第二章的小结', ['control'])
      await wait(400)
      const n08a = { path: (await cur()).path, top: await headingTop('小结') }
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(300); document.getElementById('paper').scrollTop = 0; return true`)
      await clickLink('跳到本篇小结', ['control'])
      await wait(400)
      const n08b = { path: (await cur()).path, top: await headingTop('本篇小结') }
      await clickLink('第十章', ['control'])
      const n08c = (await cur()).path
      const okTop = (t) => t !== null && t > 30 && t < 160
      check('AC-N08', '链接 02-第二章.md#小结 打开并定位到标题；#本篇小结 在本文定位；%编码路径可识别',
        n08a.path === P('02-第二章.md') && okTop(n08a.top) && n08b.path === P('01-开篇.md') && okTop(n08b.top) && n08c === P('10-第十章.md'), { n08a, n08b, n08c })

      // AC-N09 目标不存在；AC-N11 / S04 非 Markdown 文件只在资源管理器中显示
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(300); return true`)
      fake.box = []
      fake.shown = []
      fake.opened = []
      await clickLink('不存在的篇', ['control'])
      const n09 = { box: [...fake.box], path: (await cur()).path }
      await clickLink('参考资料', ['control'])
      await clickLink('危险脚本', ['control'])
      await wait(500)
      check('AC-N09', '链接目标不存在时提示「找不到“99-不存在.md”」，当前文档不变', n09.box[0] === '找不到“99-不存在.md”' && n09.path === P('01-开篇.md'), n09)
      check('AC-N11', '链接到 PDF 时在资源管理器中显示该文件', fake.shown.some((p) => p === P('资料.pdf')), fake.shown)
      check('AC-S04', '链接到 .bat 时只在资源管理器中显示，绝不运行',
        fake.shown.some((p) => p === P('run.bat')) && fake.opened.length === 0 && !fs.existsSync(P('executed.txt')), { shown: fake.shown, opened: fake.opened })

      // AC-N37 链接跳转动效（§6.6b）：抖动 → 炸开飘散 → 聚拢；跨文件夹也播放；翻页仍用翻页动效；中途再跳；减少动态效果
      const n37 = {}
      const burstStats = () => js(`const s = window.__test.linkBurst.stats, l = s.last
        return { runs: s.runs, turnRuns: window.__test.pageTurn.stats.runs, path: window.__test.state.path,
          last: l && { particles: l.particles, targets: l.targets, startMs: l.startMs, captureMs: l.captureMs, phases: l.phases, endMs: l.endMs, fps: l.fps, reduced: l.reduced },
          canvases: document.querySelectorAll('.page-turn-canvas').length, opacity: getComputedStyle(document.getElementById('editor')).opacity }`)
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(1400); return true`)
      const b0 = await burstStats()
      await clickLink('第二章', ['control'])
      n37.mid = await js(`return { canvas: !!document.querySelector('.link-burst-canvas'), opacity: document.getElementById('editor').style.opacity }`)
      await wait(2100)
      n37.first = await burstStats()
      // 跨文件夹：第一卷/02-相遇.md 里的「开篇」指向 ../01-开篇.md
      await js(`await window.__test.gotoFile(${JSON.stringify(P('第一卷/02-相遇.md'))}, { turn: false }); await T.sleep(500); return true`)
      await clickLink('开篇', ['control'])
      await wait(2100)
      n37.cross = await burstStats()
      // 上一篇 / 下一篇仍是翻页动效
      await js(`T.click('#pager .next'); await T.sleep(1300); return true`)
      n37.pager = await burstStats()
      // 动效中途再跳到别篇：停在后一篇，无残留
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}, { turn: false }); await T.sleep(500); window.__test.handleLink('02-第二章.md'); await T.sleep(700)
        window.__test.handleLink('10-第十章.md'); await T.sleep(2900); return true`)
      n37.rapid = await burstStats()
      // 视觉证据（AC-N38）：抖动、炸开飘散、聚拢，浅色和深色
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.dataset.theme = '${theme}'; window.api.setTheme('${theme}'); await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}, { turn: false }); await T.sleep(700); return true`)
        const t0 = Date.now()
        await js(`window.__test.handleLink('02-第二章.md'); return true`)
        for (const [ms, name] of [[230, '抖动'], [700, '炸开飘散'], [1550, '新页落成']]) {
          await wait(Math.max(0, ms - (Date.now() - t0)))
          await shot(`链接跳转-${theme === 'light' ? '浅色' : '深色'}-${name}`)
        }
        await wait(1200)
      }
      await js(`document.documentElement.dataset.theme = 'light'; window.api.setTheme('light'); localStorage.removeItem('theme'); return true`)
      // 减少动态效果：不产生粒子，只淡入
      const dbg37 = win.webContents.debugger
      dbg37.attach('1.3')
      await dbg37.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await js(`window.__test.handleLink('01-开篇.md'); return true`)
      n37.reducedCanvas = await js(`for (let i = 0; i < 40; i++) { if (document.querySelector('.link-burst-canvas')) return true; await T.sleep(10) } return false`)
      await wait(600)
      n37.reduced = await burstStats()
      await dbg37.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      dbg37.detach()
      const ph = n37.first.last?.phases || {}
      const clean = (r) => r.canvases === 0 && r.opacity === '1'
      check('AC-N37', `链接跳转动效：Ctrl+单击「第二章」依次抖动（0–320ms）、炸开飘散、粒子随风落成新页、换成真页（全程 ${n37.first.last?.endMs}ms，${n37.first.last?.fps}fps）；旧页粒子与新页粒子都 > 0；跨文件夹链接同样播放；上一篇 / 下一篇仍为翻页动效；中途再跳停在后一篇；减少动态效果时只淡入`,
        n37.mid.canvas && n37.mid.opacity === '0' && n37.first.runs === b0.runs + 1 && n37.first.turnRuns === b0.turnRuns &&
          n37.first.path === P('02-第二章.md') && clean(n37.first) && n37.first.last.particles > 0 && n37.first.last.targets > 0 && n37.first.last.startMs <= 100 &&
          ph.shake >= 0 && ph.shake < 100 && ph.explode >= 300 && ph.explode < 500 && ph.form >= 630 && ph.settle > ph.form && ph.reveal > ph.settle && n37.first.last.endMs <= 2600 &&
          n37.cross.runs === b0.runs + 2 && n37.cross.path === P('01-开篇.md') && clean(n37.cross) &&
          n37.pager.turnRuns === n37.cross.turnRuns + 1 && n37.pager.runs === n37.cross.runs && n37.pager.path === P('02-第二章.md') &&
          n37.rapid.path === P('10-第十章.md') && clean(n37.rapid) &&
          !n37.reducedCanvas && n37.reduced.last.reduced && n37.reduced.path === P('01-开篇.md') && clean(n37.reduced),
        n37)

      // AC-N10 有未保存修改时跳转：取消 / 不保存 / 保存
      const n10 = {}
      await js(`T.e().chain().focus('end').insertContent('跳转前的修改').run(); await T.sleep(400); return true`)
      fake.box = []
      fake.boxAnswer = 2
      await clickSel('#filesList .file-item[title="附录.md"]')
      c = await cur()
      n10.cancel = c.path === P('01-开篇.md') && c.dirty && (await js(`return T.md().includes('跳转前的修改')`))
      // AC-N14 未保存时篇目条目显示金色圆点
      names = await listNames()
      const n14 = names.find((n) => n.current)?.dot === true
      fake.boxAnswer = 1
      await clickSel('#filesList .file-item[title="附录.md"]')
      c = await cur()
      n10.discard = c.path === P('附录.md') && !fs.readFileSync(P('01-开篇.md'), 'utf8').includes('跳转前的修改')
      await js(`T.e().chain().focus('end').insertContent('要保存的修改').run(); await T.sleep(400); return true`)
      fake.boxAnswer = 0
      await clickSel('#filesList .file-item[title="01-开篇.md"]')
      c = await cur()
      n10.save = c.path === P('01-开篇.md') && fs.readFileSync(P('附录.md'), 'utf8').includes('要保存的修改')
      check('AC-N10', '有未保存修改时跳转：取消留在原篇、不保存直接跳转、保存后跳转', Object.values(n10).every(Boolean), { ...n10, box: fake.box })
      check('AC-N14', '当前篇有未保存修改时，篇目条目显示金色圆点', n14, names)

      // AC-N18 阅读模式在篇目之间保持；源码模式跳转后回到编辑
      await toMode('read')
      await clickSel('#pager .next')
      const n18a = await cur()
      await menuKey('CmdOrCtrl+]')
      await wait(500)
      const n18b = await cur()
      await toMode('edit')
      await js(`T.click('.titlebar [data-cmd=source]'); await T.sleep(300); return true`)
      await menuKey('CmdOrCtrl+[')
      await wait(500)
      const n18c = await cur()
      check('AC-N18', '阅读模式下经上一篇/下一篇跳转仍为阅读；源码模式跳转后回到编辑',
        n18a.mode === 'read' && n18a.path === P('02-第二章.md') && n18b.mode === 'read' && n18b.path === P('10-第十章.md') && n18c.mode === 'edit' && n18c.path === P('02-第二章.md'),
        { n18a, n18b, n18c })

      // AC-N20 记住阅读位置：跳走再回来、重启后、文件中间插入内容后
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(400); return true`)
      const markPos = await js(`
        const pg = document.getElementById('paper')
        const t0 = performance.now(), timeline = []
        const onScroll = () => timeline.push([Math.round(performance.now() - t0), Math.round(pg.scrollTop), window.__test.state.restoring ? 'R' : ''])
        pg.addEventListener('scroll', onScroll)
        const p = [...document.querySelectorAll('.prose p')].find(p => p.textContent.startsWith('开篇 · 第 40 段'))
        p.scrollIntoView({ block: 'start' }); await T.sleep(50)
        pg.scrollTop -= 90; await T.sleep(900)
        pg.removeEventListener('scroll', onScroll)
        const r = p.getBoundingClientRect().top - pg.getBoundingClientRect().top
        return { scrollTop: pg.scrollTop, paraTop: Math.round(r), h: pg.clientHeight, timeline, active: document.activeElement?.className, sel: T.e().state.selection.from }`)
      await js(`await window.__test.gotoFile(${JSON.stringify(P('02-第二章.md'))}); await T.sleep(400); return true`)
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(600); return true`)
      const para40 = () =>
        js(`const pg = document.getElementById('paper'); const p = [...document.querySelectorAll('.prose p')].find(p => p.textContent.startsWith('开篇 · 第 40 段')); return Math.round(p.getBoundingClientRect().top - pg.getBoundingClientRect().top)`)
      const backTop = await para40()
      await wait(700)
      await reload()
      const scrollLog = () => js(`return window.__scrollLog || []`)
      const watchScroll = () => js(`const pg = document.getElementById('paper'); const t0 = performance.now(); window.__scrollLog = []
        pg.addEventListener('scroll', () => window.__scrollLog.push([Math.round(performance.now() - t0), Math.round(pg.scrollTop), window.__test.state.restoring ? 'R' : '', (window.__test.state.path || '').slice(-8)])); return true`)
      await watchScroll()
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(700); return true`)
      const restartTop = await para40()
      const restartLog = await scrollLog()
      // 在文件开头插入几段（在资源管理器中修改的情形），再打开仍回到同一段
      const orig01 = fs.readFileSync(P('01-开篇.md'), 'utf8')
      fs.writeFileSync(P('01-开篇.md'), orig01.replace('这是连载的第一篇。', '新插入的第一段。\n\n新插入的第二段。\n\n新插入的第三段。\n\n这是连载的第一篇。'), 'utf8')
      await watchScroll()
      await js(`window.__test.loadDoc({}); await T.sleep(200); await window.__test.gotoFile(${JSON.stringify(P('01-开篇.md'))}); await T.sleep(700); return true`)
      const editedTop = await para40()
      const editedLog = await scrollLog()
      const memNow = await js(`return await window.api.memoryGet('files', ${JSON.stringify(P('01-开篇.md'))})`)
      fs.writeFileSync(P('01-开篇.md'), orig01, 'utf8')
      const tol = markPos.h * 0.1
      check('AC-N20', '记住阅读位置：跳走再回来、重启后、文件开头插入内容后，都回到同一段（误差 ≤ 一屏的 10%）',
        Math.abs(backTop - markPos.paraTop) <= tol && Math.abs(restartTop - markPos.paraTop) <= tol && Math.abs(editedTop - markPos.paraTop) <= tol,
        { 记录时: markPos.paraTop, 跳回: backTop, 重启后: restartTop, 插入内容后: editedTop, 允许误差: Math.round(tol), 滚动时间线: markPos.timeline, 焦点: markPos.active, 光标: markPos.sel,
          重启后滚动: restartLog.slice(0, 12), 插入后滚动: editedLog.slice(0, 12), 记录: memNow })

      // AC-N19 记住篇目和模式：读到第 3 篇（阅读模式）→ 重启 → 打开文件夹直接回到第 3 篇并为阅读模式
      await js(`await window.__test.gotoFile(${JSON.stringify(P('10-第十章.md'))}); await T.sleep(300); return true`)
      await toMode('read')
      await wait(700)
      await reload()
      await js(`window.__test.loadDoc({}); return true`)
      fake.openAnswer = serial
      await menuKey('CmdOrCtrl+Shift+O')
      await waitFor(async () => (await cur()).path === P('10-第十章.md'))
      fake.openAnswer = null
      const n19 = await cur()
      const memOnDisk = fs.existsSync(path.join(outDir, 'userdata', 'reading.json'))
      check('AC-N19', '重启后打开文件夹回到上次那一篇，并恢复阅读模式；记录写入程序数据目录', n19.path === P('10-第十章.md') && n19.mode === 'read' && memOnDisk, { ...n19, memOnDisk })
      await toMode('edit')

      // AC-N27b 打开过文件夹后，重启并单独打开其中子文件夹里的一篇：篇目树仍以那个文件夹为根，翻页索引的选择弹窗能选到其他文件夹的文章
      await reload()
      await loadFile(P('第一卷/01-起源.md'))
      const n27b = { root: await waitFor(async () => sameP(await js(`return window.__test.folderNav.nav.dir`), serial), 3000) }
      n27b.dir = await js(`return window.__test.folderNav.nav.dir`)
      n27b.tree = await js(`return [...document.querySelectorAll('#filesList > li')].map(li => li.title).join(',')`)
      n27b.groups = await js(`window.__test.editIndex('next'); await T.sleep(400); const g = [document.querySelector('.pick-root')?.textContent.trim(), ...[...document.querySelectorAll('.pick-folder')].map(f => (f.classList.contains('open') ? '▾' : '▸') + f.dataset.key)]; document.querySelector('.modal [data-act=cancel]')?.click(); await T.sleep(200); return g`)
      await js(`const d = await window.api.readFile(${JSON.stringify(path.join(__dirname, '..', 'samples', 'github', 'README.md'))}); window.__test.loadDoc(d); await T.sleep(800); return true`)
      n27b.outside = await js(`return window.__test.folderNav.nav.dir`)
      check('AC-N27b', '打开过文件夹后重启，单独打开其子文件夹里的一篇：篇目树仍以该文件夹为根（含其他文件夹），选择弹窗的篇目树以「连载」为根，只展开本篇所在的「第一卷」，「子文件夹」收起；不在打开过的文件夹里的文件仍以自己的文件夹为根',
        n27b.root >= 0 && n27b.dir === serial && n27b.tree.startsWith('第一卷,01-起源.md,02-相遇.md,子文件夹,01-开篇.md,02-第二章.md,10-第十章.md,附录.md') &&
          n27b.groups.join(',') === '连载,▾第一卷,▸子文件夹' && sameP(n27b.outside, path.join(__dirname, '..', 'samples', 'github')),
        n27b)

      // =================== v1.5：翻页索引（属性区里的 prev / next，§4.13b） ===================
      const ixDir = path.join(tmpDir, '索引')
      fs.cpSync(path.join(__dirname, '..', 'samples', '索引'), ixDir, { recursive: true })
      const X = (n) => path.join(ixDir, n)
      const ixOrig = {}
      for (const f of ['01-甲.md', '02-乙.md', '05-戊.md', '06-己.md', '子/03-丙.md', '子/04-丁.md']) ixOrig[f] = fs.readFileSync(X(f), 'utf8')
      fake.boxAnswer = 1
      // 卡片：[{ side, kind: card|ghost|missing, label, title, edit }]
      const cards = () => js(`return [...document.querySelectorAll('#pager .pager-slot')].map(s => { const c = s.querySelector('.pager-card')
        return { side: s.dataset.side, kind: c.classList.contains('ghost') ? 'ghost' : c.classList.contains('missing') ? 'missing' : 'card',
          label: c.querySelector('.pager-label').textContent.trim(), title: c.querySelector('.pager-title').textContent.trim(), edit: !!s.querySelector('.pager-edit') } })`)
      const card = (list, side) => list.find((c) => c.side === side) || null
      // 双向对应的询问弹窗：记下提示文字并点指定的按钮；没有弹窗时返回 null
      const answerAsk = async (label) => {
        const msg = await js(`for (let i = 0; i < 20 && !document.querySelector('.ask-modal'); i++) await T.sleep(50)
          return document.querySelector('.ask-modal .modal-message')?.textContent || null`)
        if (msg) await js(`[...document.querySelectorAll('.ask-modal .btn')].find(b => b.textContent === ${JSON.stringify(label)}).click(); await T.sleep(400); return true`)
        return msg
      }
      const pickTarget = async (side, sub) => {
        await clickSel(`#pager .pager-slot[data-side=${side}] .pager-edit, #pager .pager-slot[data-side=${side}] .ghost`)
        await js(`await T.pickKey(${JSON.stringify(sub)}); await T.sleep(300); return true`)
      }
      const pickButton = async (side, label) => {
        await clickSel(`#pager .pager-slot[data-side=${side}] .pager-edit, #pager .pager-slot[data-side=${side}] .ghost`)
        await js(`[...document.querySelectorAll('.pick-modal .btn')].find(b => b.textContent === ${JSON.stringify(label)}).click(); await T.sleep(400); return true`)
      }
      await toMode('edit')
      await js(`window.__test.loadDoc({}); await T.sleep(200); await window.__test.openFolder(${JSON.stringify(ixDir)}); await T.sleep(600); return true`)

      // AC-N30 属性区原样保留、正确显示
      const n30 = { files: {} }
      for (const f of Object.keys(ixOrig)) {
        await loadFile(X(f))
        const r = await js(`return { md: T.md(), chip: document.querySelector('.prose .front-matter-chip')?.textContent || null, hr: document.querySelectorAll('.prose hr').length,
          h1: [...document.querySelectorAll('.prose h1, .prose h2')].map(h => h.textContent) }`)
        n30.files[f] = { same: r.md === ixOrig[f], chip: r.chip, hr: r.hr, h: r.h1.join('/') }
      }
      await loadFile(X('01-甲.md'))
      await toMode('read')
      n30.readChip = await js(`const c = document.querySelector('.prose .front-matter'); return !!c && c.getBoundingClientRect().height > 0`)
      await toMode('edit')
      await clickSel('.prose .front-matter-chip')
      n30.source = await js(`return { mode: window.__test.state.mode, head: document.getElementById('source').value.split('\\n').slice(0, 5).join('\\n') }`)
      await js(`T.click('.titlebar [data-cmd=source]'); await T.sleep(300); return true`)
      n30.back = await js(`return { mode: window.__test.state.mode, dirty: T.dirty(), chip: document.querySelector('.prose .front-matter-chip')?.textContent }`)
      const F = n30.files
      check('AC-N30', '属性区原样保留：6 个样本不修改时逐字一致（含 Windows 换行）；不再显示成分隔线 + 大标题，编辑模式为「属性 · 键名」小标签、阅读模式隐藏；点小标签进入源码模式；「己」仍是两条分隔线',
        Object.values(F).every((x) => x.same) && F['01-甲.md'].chip === '属性 · title、tags、next' && F['01-甲.md'].hr === 0 && F['01-甲.md'].h === '甲' &&
          F['子/03-丙.md'].chip === '属性 · prev、next' && F['05-戊.md'].chip === '属性 · author' && F['02-乙.md'].chip === null &&
          F['06-己.md'].chip === null && F['06-己.md'].hr === 2 && !n30.readChip && n30.source.mode === 'source' && n30.source.head.startsWith('---\ntitle: 甲篇') &&
          n30.back.mode === 'edit' && !n30.back.dirty && n30.back.chip === '属性 · title、tags、next',
        n30)

      // AC-N28 识别：指定的下一篇跨文件夹、自定义文字、不显示、#标题；没有属性区的按文件名
      const n28 = {}
      await loadFile(X('01-甲.md'))
      n28.mode0 = await js(`return window.__test.state.mode`)
      n28.jia = await cards()
      const runs0 = await js(`return window.__test.pageTurn.stats.runs`)
      await menuKey('CmdOrCtrl+]')
      await wait(1300)
      n28.afterNext = { path: (await cur()).path, dir: await js(`return window.__test.pageTurn.stats.last?.dir`), runs: await js(`return window.__test.pageTurn.stats.runs`) }
      n28.bing = await cards()
      await toMode('read')
      n28.bingRead = await cards()
      await toMode('edit')
      await menuKey('CmdOrCtrl+[')
      await wait(1300)
      n28.afterPrev = { path: (await cur()).path, dir: await js(`return window.__test.pageTurn.stats.last?.dir`) }
      await loadFile(X('子/04-丁.md'))
      n28.ding = await cards()
      fake.box = []
      await js(`T.click('#pager .pager-slot[data-side=prev] .pager-card'); await T.sleep(1300); return true`)
      n28.dingPrev = { path: (await cur()).path, box: [...fake.box] }
      await loadFile(X('02-乙.md'))
      n28.yi = await cards()
      const C = (l, s) => card(l, s) || {}
      check('AC-N28', '识别翻页索引：「甲」的下一篇是子文件夹里的「丙」并按向后翻播放动效；「丙」上一篇显示「回到开头」、阅读模式无下一篇，Ctrl+[ 回到「甲」向前翻；「丁」的上一篇「丙篇」可打开；「乙」按文件名顺序',
        C(n28.jia, 'next').title === '丙' && C(n28.jia, 'next').kind === 'card' && n28.afterNext.path === X('子/03-丙.md') && n28.afterNext.dir === 1 && n28.afterNext.runs > runs0 &&
          C(n28.bing, 'prev').title === '回到开头' && C(n28.bing, 'next').kind === 'ghost' && C(n28.bingRead, 'prev').title === '回到开头' && !card(n28.bingRead, 'next') &&
          n28.afterPrev.path === X('01-甲.md') && n28.afterPrev.dir === -1 &&
          C(n28.ding, 'prev').title === '丙篇' && n28.dingPrev.path === X('子/03-丙.md') && n28.dingPrev.box.length === 0 &&
          C(n28.yi, 'prev').title === '甲' && C(n28.yi, 'next').title === '戊',
        n28)

      // AC-N29 目标不存在
      await loadFile(X('子/04-丁.md'))
      const n29 = { cards: await cards() }
      fake.box = []
      await js(`T.click('#pager .pager-slot[data-side=next] .pager-card'); await T.sleep(500); return true`)
      n29.click = { box: [...fake.box], path: (await cur()).path }
      fake.box = []
      await menuKey('CmdOrCtrl+]')
      await wait(500)
      n29.key = { box: [...fake.box], path: (await cur()).path }
      check('AC-N29', '目标不存在：卡片显示「找不到 不存在.md」；点击或 Ctrl+] 提示「找不到“不存在.md”」，当前文档不变',
        C(n29.cards, 'next').kind === 'missing' && C(n29.cards, 'next').title === '找不到 不存在.md' &&
          n29.click.box[0] === '找不到“不存在.md”' && n29.click.path === X('子/04-丁.md') && n29.key.box[0] === '找不到“不存在.md”' && n29.key.path === X('子/04-丁.md'),
        n29)

      // AC-N31 在卡片上指定：悬停出现「更改」；弹窗列出全部篇目；搜索 + 回车确定；写进源文件；撤销；保存
      const n31 = {}
      await loadFile(X('02-乙.md'))
      const editBox = await js(`const r = document.querySelector('#pager .pager-slot[data-side=next] .pager-card').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`)
      n31.opacityBefore = await js(`return getComputedStyle(document.querySelector('#pager .pager-slot[data-side=next] .pager-edit')).opacity`)
      ensureVisible()
      win.webContents.sendInputEvent({ type: 'mouseMove', x: editBox.x, y: editBox.y })
      await wait(400)
      n31.opacityHover = await js(`return getComputedStyle(document.querySelector('#pager .pager-slot[data-side=next] .pager-edit')).opacity`)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: editBox.x, y: 200 })
      await clickSel('#pager .pager-slot[data-side=next] .pager-edit')
      n31.picker = await js(`return { title: document.querySelector('.pick-modal .modal-title')?.textContent, focus: document.activeElement?.className,
        items: [...document.querySelectorAll('.pick-item')].map(li => ({ title: li.querySelector('.pick-title').textContent, sub: li.dataset.key, disabled: li.classList.contains('disabled'), current: li.classList.contains('current') })),
        root: document.querySelector('.pick-root')?.textContent.trim(),
        order: [...document.querySelectorAll('.pick-list > li')].map(li => li.classList.contains('pick-folder') ? (li.classList.contains('open') ? '▾' : '▸') + li.dataset.key : li.dataset.key).join(','),
        buttons: [...document.querySelectorAll('.pick-modal .btn')].map(b => b.textContent) }`)
      await type('丙')
      n31.filtered = await js(`return [...document.querySelectorAll('.pick-list > li')].map(li => li.classList.contains('pick-folder') ? (li.classList.contains('open') ? '▾' : '▸') + li.dataset.key : li.dataset.key)`)
      await key('Return')
      await wait(500)
      // 双向对应：「丙」的上一篇已指定为「甲」（显示为「回到开头」）→ 询问；这里选「保留原来的」，改为的情形见 AC-N35
      n31.ask = await answerAsk('保留原来的')
      n31.after ={ md: await js(`return T.md()`), dirty: (await cur()).dirty, cards: await cards(), modal: await js(`return !!document.querySelector('.modal-mask')`) }
      await menuKey('CmdOrCtrl+Z')
      await wait(500)
      n31.undo = { same: (await js(`return T.md()`)) === ixOrig['02-乙.md'], dirty: (await cur()).dirty, next: C(await cards(), 'next').title }
      await menuKey('CmdOrCtrl+Y')
      await wait(500)
      n31.redo = { next: C(await cards(), 'next').title, dirty: (await cur()).dirty }
      await menuKey('CmdOrCtrl+S')
      await wait(600)
      n31.saved = fs.readFileSync(X('02-乙.md'), 'utf8')
      n31.bingKept = fs.readFileSync(X('子/03-丙.md'), 'utf8') === ixOrig['子/03-丙.md'] // 选了保留：另一篇不动
      await loadFile(X('01-甲.md'))
      await loadFile(X('02-乙.md'))
      n31.reopen = C(await cards(), 'next')
      await toMode('read')
      n31.readMode = await js(`return { edit: document.querySelectorAll('#pager .pager-edit').length, ghost: document.querySelectorAll('#pager .ghost').length }`)
      await toMode('edit')
      const expect31 = '---\nnext: 子/03-丙.md\n---\n\n' + ixOrig['02-乙.md']
      const pk = n31.picker
      check('AC-N31', '在卡片上指定：悬停出现「更改」；弹窗是与侧栏相同的可折叠篇目树（根「索引」下只展开本篇所在的那一层，文件夹「子」收起；自己显示「（本篇）」不可选、当前目标打勾）；搜索「丙」只剩「子」文件夹（自动展开）里的一项，回车确定；「丙」的上一篇已指定，询问后选保留则保存时不动「丙」；卡片立即更新、标「已指定」，文档未保存，源文件开头新增属性区；Ctrl+Z 恢复原文、Ctrl+Y 重做；保存后内容正确，重新打开仍有效；阅读模式无编辑元素',
        n31.opacityBefore === '0' && n31.opacityHover === '1' && pk.title === '指定下一篇' && /pick-search/.test(pk.focus) && pk.items.length === 4 &&
          pk.items.find((i) => i.sub === '02-乙.md')?.disabled && pk.items.find((i) => i.sub === '05-戊.md')?.current && pk.items.filter((i) => i.current).length === 1 &&
          pk.buttons.join(',') === '其他位置…,不显示,取消' && n31.filtered.join(',') === '▾子,子/03-丙.md' && !n31.after.modal &&
          pk.root === '索引' && pk.order === '▸子,01-甲.md,02-乙.md,05-戊.md,06-己.md' && pk.items.find((i) => i.sub === '02-乙.md')?.title === '乙（本篇）' &&
          n31.ask === '「丙」的上一篇已经指定为「回到开头」。要改为「乙」吗？' && n31.bingKept &&
          n31.after.md === expect31 && n31.after.dirty && C(n31.after.cards, 'next').title === '丙' && C(n31.after.cards, 'next').label.startsWith('已指定') &&
          n31.undo.same && !n31.undo.dirty && n31.undo.next === '戊' && n31.redo.next === '丙' && n31.redo.dirty &&
          n31.saved === expect31 && n31.reopen.title === '丙' && n31.readMode.edit === 0 && n31.readMode.ghost === 0,
        n31)

      // AC-N32 只改这一行；Windows 换行；恢复默认顺序；其他位置
      const n32 = {}
      await loadFile(X('01-甲.md'))
      await clickSel('#pager .pager-slot[data-side=next] .pager-edit')
      await js(`await T.pickKey('02-乙.md'); await T.sleep(400); return true`)
      await clickSel('#pager .pager-slot[data-side=prev] .pager-card') // 占位卡片
      n32.prevButtons = await js(`return [...document.querySelectorAll('.pick-modal .btn')].map(b => b.textContent)`)
      await js(`[...document.querySelectorAll('.pick-modal .btn')].find(b => b.textContent === '不显示').click(); await T.sleep(400); return true`)
      n32.jia = await js(`return T.md()`)
      n32.jiaCards = await cards()
      await loadFile(X('05-戊.md'))
      await clickSel('#pager .pager-slot[data-side=next] .pager-edit')
      await js(`await T.pickKey('子/04-丁.md'); await T.sleep(400); return true`)
      n32.wuAsk = await answerAsk('保留原来的') // 「丁」的上一篇已指定为「丙」
      n32.wu = await js(`return T.md()`)
      await clickSel('#pager .pager-slot[data-side=next] .pager-edit')
      await js(`[...document.querySelectorAll('.pick-modal .btn')].find(b => b.textContent === '恢复默认顺序').click(); await T.sleep(400); return true`)
      n32.wuDefault = await js(`return { same: T.md() === ${JSON.stringify(ixOrig['05-戊.md'])}, dirty: T.dirty() }`)
      await loadFile(X('子/03-丙.md'))
      for (const side of ['prev', 'next']) {
        await clickSel(`#pager .pager-slot[data-side=${side}] .pager-${side === 'prev' ? 'edit' : 'card'}`)
        await js(`[...document.querySelectorAll('.pick-modal .btn')].find(b => b.textContent === '恢复默认顺序').click(); await T.sleep(400); return true`)
      }
      n32.bingDefault = await js(`return { md: T.md(), chip: !!document.querySelector('.prose .front-matter') }`)
      fake.openAnswer = X('06-己.md')
      await loadFile(X('子/04-丁.md'))
      await clickSel('#pager .pager-slot[data-side=next] .pager-edit')
      await js(`[...document.querySelectorAll('.pick-modal .btn')].find(b => b.textContent === '其他位置…').click(); await T.sleep(600); return true`)
      fake.openAnswer = null
      n32.other = { md: await js(`return T.md()`), next: C(await cards(), 'next') }
      await js(`window.__test.loadDoc({}); await T.sleep(200); return true`)
      const jiaLines = n32.jia.split('\n')
      check('AC-N32', '只改这一行：「甲」的 title、tags 不变，next 被替换，prev: false 加在 next 前；Windows 换行文档新增行也是 CRLF；恢复默认顺序删掉这一项，删光时整个属性区删除、文件恢复原样；其他位置选的文件写为相对路径',
        jiaLines.slice(0, 6).join('\n') === '---\ntitle: 甲篇\ntags: [示例, 翻页]\nprev: false\nnext: 02-乙.md\n---' && n32.jia.endsWith(ixOrig['01-甲.md'].split('---\n\n')[1]) &&
          n32.prevButtons.join(',') === '其他位置…,不显示,取消' && C(n32.jiaCards, 'prev').title === '已隐藏 · 点击更改' && C(n32.jiaCards, 'next').title === '乙' &&
          n32.wu === '---\r\nauthor: 某人\r\nnext: 子/04-丁.md\r\n---\r\n\r\n# 戊\r\n\r\n这一篇用 Windows 换行。\r\n' && n32.wuDefault.same && !n32.wuDefault.dirty &&
          n32.bingDefault.md === '# 丙\n\n上一篇卡片显示「回到开头」，没有下一篇。\n' && !n32.bingDefault.chip &&
          n32.other.md.startsWith('---\nprev: { text: 丙篇, link: "03-丙.md#丙" }\nnext: ../06-己.md\n---') && n32.other.next.title === '己',
        n32)

      // AC-N33 不会误删属性区；撤销 / 重做
      const n33 = {}
      await loadFile(X('子/03-丙.md'))
      await js(`T.e().commands.focus(); T.e().commands.setTextSelection(T.e().state.doc.firstChild.nodeSize + 1); await T.sleep(100); return true`)
      for (let i = 0; i < 3; i++) await key('Backspace')
      n33.backspace = await js(`return { first: T.e().state.doc.firstChild.type.name, raw: T.e().state.doc.firstChild.attrs.raw }`)
      await key('a', ['control'])
      await key('Delete')
      await wait(300)
      n33.selectAll = await js(`return { first: T.e().state.doc.firstChild.type.name, raw: T.e().state.doc.firstChild.attrs.raw, chip: !!document.querySelector('.prose .front-matter-chip') }`)
      const raw33 = ixOrig['子/03-丙.md'].split('\n\n')[0]
      await wait(400)
      await js(`window.__test.loadDoc({}); await T.sleep(200)
        for (const f of ${JSON.stringify(Object.keys(ixOrig).map((f) => X(f)))}) window.api.clearDraft('draft:' + f)
        await T.sleep(100); return true`)
      check('AC-N33', '光标在正文开头连按 3 次退格、全选后删除，属性区仍在且不变（撤销 / 重做见 AC-N31）',
        n33.backspace.first === 'frontMatter' && n33.backspace.raw === raw33 && n33.selectAll.first === 'frontMatter' && n33.selectAll.raw === raw33 && n33.selectAll.chip,
        n33)
      // AC-N35 双向对应：保存时同步另一篇；冲突先问；换掉 / 去掉时删掉对方指回本篇的一项；撤销后不保存不动另一篇
      const n35 = {}
      const rd = (f) => fs.readFileSync(X(f), 'utf8')
      const toastText = () => js(`return document.querySelector('.toast.show')?.textContent || null`)
      fs.writeFileSync(X('02-乙.md'), ixOrig['02-乙.md'], 'utf8') // 从原样开始（AC-N31 保存过）
      await loadFile(X('02-乙.md'))
      await pickTarget('next', '子/03-丙.md')
      n35.ask = await answerAsk('改为「乙」')
      await menuKey('CmdOrCtrl+S')
      await wait(900)
      n35.save1 = { toast: await toastText(), yi: rd('02-乙.md'), bing: rd('子/03-丙.md') }
      await loadFile(X('子/03-丙.md'))
      n35.bingPrev = C(await cards(), 'prev').title
      await loadFile(X('02-乙.md'))
      await pickTarget('next', '06-己.md')
      n35.askJi = await answerAsk('保留原来的') // 「己」没有指定上一篇：不应询问
      await menuKey('CmdOrCtrl+S')
      await wait(900)
      n35.save2 = { toast: await toastText(), bing: rd('子/03-丙.md'), ji: rd('06-己.md') }
      await pickButton('next', '恢复默认顺序')
      await menuKey('CmdOrCtrl+S')
      await wait(900)
      n35.save3 = { yi: rd('02-乙.md') === ixOrig['02-乙.md'], ji: rd('06-己.md') === ixOrig['06-己.md'] }
      await pickTarget('next', '子/04-丁.md')
      n35.askDing = await answerAsk('改为「乙」')
      await menuKey('CmdOrCtrl+Z')
      await wait(400)
      await menuKey('CmdOrCtrl+S')
      await wait(900)
      n35.undo = { dirty: (await cur()).dirty, ding: rd('子/04-丁.md') === ixOrig['子/04-丁.md'], yi: rd('02-乙.md') === ixOrig['02-乙.md'] }
      const bingBody = ixOrig['子/03-丙.md'].split('---\n\n')[1]
      check('AC-N35', '双向对应：「乙」指定下一篇「丙」时询问（「丙」的上一篇已是「回到开头」），选改为并保存 → 「丙」的 prev 改为 ../02-乙.md、其余不变，提示同步，从「丙」可翻回「乙」；改为「己」并保存 → 「丙」的 prev 删除、「己」新建 prev: 02-乙.md（原分隔线保留）且不询问；恢复默认并保存 → 两篇都恢复原样；撤销后保存不动另一篇',
        n35.ask === '「丙」的上一篇已经指定为「回到开头」。要改为「乙」吗？' &&
          n35.save1.yi === '---\nnext: 子/03-丙.md\n---\n\n' + ixOrig['02-乙.md'] && n35.save1.bing === '---\nprev: ../02-乙.md\nnext: false\n---\n\n' + bingBody &&
          n35.save1.toast === '已保存 · 同步了「丙」的上一篇' && n35.bingPrev === '乙' &&
          n35.askJi === null && n35.save2.bing === '---\nnext: false\n---\n\n' + bingBody && n35.save2.ji === '---\nprev: 02-乙.md\n---\n\n' + ixOrig['06-己.md'] &&
          n35.save2.toast === '已保存 · 同步了「丙」的上一篇、「己」的上一篇' && n35.save3.yi && n35.save3.ji &&
          n35.askDing === '「丁」的上一篇已经指定为「丙篇」。要改为「乙」吗？' && !n35.undo.dirty && n35.undo.ding && n35.undo.yi,
        n35)

      // AC-N36 另一篇正在别的窗口打开：不写它的文件，改那个窗口里的内容并标为未保存
      const n36 = {}
      await js(`window.api.openPath(${JSON.stringify(X('子/04-丁.md'))}); return true`)
      let w36 = null
      for (let i = 0; i < 60 && !w36; i++) {
        await wait(100)
        w36 = BrowserWindow.getAllWindows().find((w) => w !== win) || null
      }
      if (w36) {
        await new Promise((r) => (w36.webContents.isLoading() ? w36.webContents.once('did-finish-load', r) : r()))
        await wait(1500)
        win.focus()
        await wait(300)
        await loadFile(X('05-戊.md'))
        await pickTarget('next', '子/04-丁.md')
        n36.ask = await answerAsk('改为「戊」')
        await menuKey('CmdOrCtrl+S')
        await wait(1200)
        n36.wu = rd('05-戊.md')
        n36.dingFile = rd('子/04-丁.md') === ixOrig['子/04-丁.md']
        n36.other = await w36.webContents.executeJavaScript(`({ path: window.__test.state.path, dirty: window.__test.state.dirty,
          prev: window.__test.state.index.prev?.path || null, md: window.__editor.storage.markdown.getMarkdown(), toast: document.querySelector('.toast')?.textContent || null })`)
        await w36.webContents.executeJavaScript(`window.api.clearDraft('draft:' + window.__test.state.path); true`)
        await wait(200)
        w36.destroy()
        await wait(300)
      }
      check('AC-N36', '另一篇在第二个窗口打开：给「戊」指定下一篇「丁」并保存后，「丁」的文件不变；第二个窗口里「丁」的上一篇变为「戊」、标为未保存并提示保存',
        !!w36 && n36.ask === '「丁」的上一篇已经指定为「丙篇」。要改为「戊」吗？' && n36.wu.startsWith('---\r\nauthor: 某人\r\nnext: 子/04-丁.md\r\n---') && n36.dingFile &&
          n36.other && n36.other.dirty && sameP(n36.other.prev, X('05-戊.md')) && n36.other.md.startsWith('---\nprev: ../05-戊.md\nnext: 不存在.md\n---') &&
          /记得保存/.test(n36.other.toast || ''),
        { opened: !!w36, ...n36 })
      await js(`window.__test.loadDoc({}); await T.sleep(200)
        for (const f of ${JSON.stringify(Object.keys(ixOrig).map((f) => X(f)))}) window.api.clearDraft('draft:' + f)
        await T.sleep(100); return true`)

      // 只改测试副本，样本文件保持不变
      check('AC-N21b', '翻页索引测试只改测试副本，samples/索引 中的文件未被改动',
        Object.keys(ixOrig).every((f) => fs.readFileSync(path.join(__dirname, '..', 'samples', '索引', f), 'utf8') === ixOrig[f]), null)

      // AC-N13 打开文件夹（无记录时打开第一篇）；空文件夹提示
      const fresh = path.join(tmpDir, '新文件夹')
      fs.mkdirSync(fresh, { recursive: true })
      fs.writeFileSync(path.join(fresh, 'b.md'), '# B\n', 'utf8')
      fs.writeFileSync(path.join(fresh, 'a.md'), '# A\n', 'utf8')
      const emptyDir = path.join(tmpDir, '空文件夹')
      fs.mkdirSync(emptyDir, { recursive: true })
      await js(`await window.__test.openFolder(${JSON.stringify(fresh)}); await T.sleep(400); return true`)
      const n13a = (await cur()).path
      await js(`await window.__test.openFolder(${JSON.stringify(emptyDir)}); await T.sleep(300); return true`)
      const n13b = await js(`return { dir: window.__test.folderNav.nav.dir, empty: document.querySelector('#filesList .files-empty p')?.textContent || null }`)
      check('AC-N13', '打开文件夹（无记录）打开第一篇；空文件夹作为篇目树打开（空状态见 AC-F20）',
        n13a === path.join(fresh, 'a.md') && sameP(n13b.dir, emptyDir) && /还没有 Markdown 文件/.test(n13b.empty || ''), { n13a, ...n13b })

      // AC-N15 另存为到其他文件夹后，篇目切换
      await js(`await window.__test.gotoFile(${JSON.stringify(P('附录.md'))}); await T.sleep(300); return true`)
      fake.saveAnswer = path.join(fresh, 'c-另存.md')
      await menuKey('CmdOrCtrl+Shift+S')
      await waitFor(async () => (await js(`return window.__test.folderNav.nav.dir`)) === fresh)
      names = await listNames()
      check('AC-N15', '另存为到其他文件夹后，篇目切换为新文件夹', names.map((n) => n.name).join(',') === 'a.md,b.md,c-另存.md' && names[2].current, names)

      // AC-N12 资源管理器中新增、重命名、删除后自动刷新；当前篇被删除时保留内容并标为未保存
      await js(`await window.__test.gotoFile(${JSON.stringify(P('附录.md'))}); await T.sleep(400); return true`)
      fs.writeFileSync(P('03-新增.md'), '# 新增\n', 'utf8')
      const tAdd = await waitFor(async () => (await listNames()).some((n) => n.name === '03-新增.md'))
      fs.renameSync(P('10-第十章.md'), P('11-第十一章.md'))
      const tRen = await waitFor(async () => {
        const ns = (await listNames()).map((n) => n.name)
        return ns.includes('11-第十一章.md') && !ns.includes('10-第十章.md')
      })
      fs.rmSync(P('附录.md'))
      const tDel = await waitFor(async () => !(await listNames()).some((n) => n.name === '附录.md'))
      await wait(300)
      const n12 = await cur()
      const kept = await js(`return T.md().includes('没有编号的文章排在最后')`)
      check('AC-N12', '新增、重命名、删除篇目后 2 秒内自动刷新；当前篇被删除时内容保留并标为未保存',
        tAdd >= 0 && tAdd <= 2000 && tRen >= 0 && tRen <= 2000 && tDel >= 0 && tDel <= 2000 && n12.dirty && kept, { 新增ms: tAdd, 改名ms: tRen, 删除ms: tDel, dirty: n12.dirty, kept })
      fake.boxAnswer = 1

      // AC-N17 50 篇的文件夹：列出和跳转耗时
      const big = path.join(tmpDir, '五十篇')
      fs.mkdirSync(big, { recursive: true })
      for (let i = 1; i <= 50; i++) fs.writeFileSync(path.join(big, `${String(i).padStart(2, '0')}-第${i}篇.md`), `# 第 ${i} 篇\n\n${'内容。'.repeat(200)}\n`, 'utf8')
      const perf = await js(`
        const t0 = performance.now()
        await window.__test.openFolder(${JSON.stringify(big)})
        while (document.querySelectorAll('#filesList .file-item').length < 50) await T.sleep(5)
        const list = performance.now() - t0
        const t1 = performance.now()
        await window.__test.gotoFile(${JSON.stringify(path.join(big, '25-第25篇.md'))})
        const jump = performance.now() - t1
        return { list: Math.round(list), jump: Math.round(jump) }`)
      check('AC-N17', '50 篇的文件夹：篇目出现 ≤ 300ms，篇目间跳转 ≤ 300ms', perf.list <= 300 && perf.jump <= 300, perf)

      // AC-N21 阅读记录不在用户文件夹写入任何文件（用一份未被改动过的副本，阅读、跳转、滚动、切换模式后比对）
      const readOnlyCopy = path.join(tmpDir, '只读对比')
      fs.cpSync(serialSrc, readOnlyCopy, { recursive: true })
      const snap = (d) =>
        fs.readdirSync(d, { recursive: true }).sort().map((f) => {
          const st = fs.statSync(path.join(d, f))
          return `${f}|${st.size}|${st.mtimeMs}`
        }).join('\n')
      const before21 = snap(readOnlyCopy)
      await js(`
        await window.__test.openFolder(${JSON.stringify(readOnlyCopy)}); await T.sleep(300)
        document.getElementById('paper').scrollTop = 800; await T.sleep(700)
        T.click('#pager .next'); await T.sleep(500)
        T.click('.mode-switch .seg-item[data-value=read]'); await T.sleep(300)
        T.click('#pager .prev'); await T.sleep(700)
        T.click('.mode-switch .seg-item[data-value=edit]'); await T.sleep(300)
        return true`)
      await wait(800)
      check('AC-N21', '阅读、跳转、滚动、切换模式后，用户文件夹中的文件完全不变（没有新增文件）', snap(readOnlyCopy) === before21, null)

      // AC-N22 「打开」按钮右键菜单
      const origBuild = Menu.buildFromTemplate
      let captured = null
      Menu.buildFromTemplate = (t) => {
        const m = origBuild.call(Menu, t)
        captured = { t, m }
        m.popup = () => {}
        return m
      }
      await js(`document.querySelector('.titlebar [data-cmd=open]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true`)
      await waitFor(async () => !!captured)
      Menu.buildFromTemplate = origBuild
      const labels = captured ? captured.t.map((i) => i.label) : []
      fake.openAnswer = fresh
      captured?.m.items.find((i) => i.label === '打开文件夹…')?.click()
      await waitFor(async () => (await js(`return window.__test.folderNav.nav.dir`)) === fresh)
      fake.openAnswer = null
      const n22dir = await js(`return window.__test.folderNav.nav.dir`)
      check('AC-N22', '「打开」按钮右键出现「打开文件… / 打开文件夹…」，打开文件夹可用', labels.join(',') === '打开文件…,打开文件夹…' && n22dir === fresh, { labels, n22dir })

      // AC-N03（后半）手动切换「大纲」后，重启仍保持
      await js(`T.click('#sideSlot .seg-item[data-value=outline]'); await T.sleep(300); return true`)
      await reload()
      await loadFile(P('02-第二章.md'))
      const side1 = await js(`return document.body.dataset.side`)
      await js(`T.click('#sideSlot .seg-item[data-value=files]'); await T.sleep(300); return true`)
      check('AC-N03', '有 2 篇及以上时默认显示篇目；手动切换的选择在重启后保持', side0.side === 'files' && side0.seg === 'files' && side1 === 'outline', { side0, side1 })

      // AC-R08 滑块：点击切换、Ctrl+R 同步
      const sw = () => js(`const s = document.querySelector('.mode-switch'); return { value: s.dataset.value, mode: window.__test.state.mode, thumb: s.querySelector('.seg-thumb').style.transform, readBtn: !!document.querySelector('.titlebar [data-cmd=read]') }`)
      const r08a = await sw()
      await toMode('read')
      const r08b = await sw()
      await menuKey('CmdOrCtrl+R')
      await wait(300)
      const r08c = await sw()
      check('AC-R08', '标题栏「编辑 | 阅读」滑块：停在当前模式，点击切换，Ctrl+R 时同步移动',
        r08a.value === 'edit' && r08b.value === 'read' && r08b.mode === 'read' && r08b.thumb === 'translateX(100%)' && r08c.value === 'edit' && r08c.mode === 'edit',
        { r08a, r08b, r08c })
      check('AC-R11b', '原「阅读」图标按钮已移除', !r08a.readBtn, null)

      // AC-R09 拖动滑块、←/→ 切换
      const r09 = {}
      const swBox = await js(`const r = document.querySelector('.mode-switch').getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top + r.height / 2), w: Math.round(r.width) }`)
      ensureVisible()
      if (!win.isFocused()) {
        win.focus()
        await wait(150)
      }
      if (win.isFocused()) {
        const ev = (type, x) => win.webContents.sendInputEvent({ type, x, y: swBox.t, button: 'left', clickCount: 1 })
        ev('mouseDown', swBox.l + 20)
        for (let x = swBox.l + 24; x <= swBox.l + swBox.w - 10; x += 8) {
          ev('mouseMove', x)
          await wait(16)
        }
        ev('mouseUp', swBox.l + swBox.w - 10)
        r09.how = '真实鼠标'
      } else {
        await js(`
          const s = document.querySelector('.mode-switch')
          const pe = (type, x) => s.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: ${swBox.t}, pointerId: 1, button: 0 }))
          pe('pointerdown', ${swBox.l + 20}); for (let x = ${swBox.l + 24}; x <= ${swBox.l + swBox.w - 10}; x += 8) pe('pointermove', x); pe('pointerup', ${swBox.l + swBox.w - 10})
          s.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true`)
        r09.how = '模拟事件'
      }
      await wait(400)
      r09.drag = (await sw()).mode === 'read'
      await js(`const s = document.querySelector('.mode-switch'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await T.sleep(300); return true`)
      r09.left = (await sw()).mode === 'edit'
      await js(`const s = document.querySelector('.mode-switch'); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await T.sleep(300); return true`)
      r09.right = (await sw()).mode === 'read'
      await toMode('edit')
      check('AC-R09', '拖动滑块到另一侧松手即切换；←/→ 切换', r09.drag && r09.left && r09.right, r09)

      // AC-R08b 真实鼠标点击滑块（按下时捕获了指针，click 落在整个控件上——必须按松开位置判断）；按下有反馈
      const mouseClick = async (sel, hold = 60) => {
        const b = await js(`const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`)
        ensureVisible()
        win.webContents.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'left', clickCount: 1 })
        await wait(hold)
        const pressed = await js(`const s = document.querySelector(${JSON.stringify(sel)}).closest('.segmented'); return { pressing: s.classList.contains('pressing'), pressed: !!s.querySelector('.seg-item.pressed') }`)
        win.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 })
        await wait(400)
        return pressed
      }
      const r08m = {}
      r08m.pressOther = await mouseClick('.mode-switch .seg-item[data-value=read]')
      r08m.read = (await sw()).mode
      r08m.pressSame = await mouseClick('.mode-switch .seg-item[data-value=read]')
      r08m.stillRead = (await sw()).mode
      await mouseClick('.mode-switch .seg-item[data-value=edit]')
      r08m.edit = (await sw()).mode
      await mouseClick('#sideSlot .seg-item[data-value=outline]')
      r08m.outline = await js(`return document.body.dataset.side`)
      await mouseClick('#sideSlot .seg-item[data-value=files]')
      r08m.files = await js(`return document.body.dataset.side`)
      r08m.after = await js(`return { pressing: !!document.querySelector('.segmented.pressing'), pressed: !!document.querySelector('.seg-item.pressed') }`)
      check('AC-R08b', '真实鼠标单击滑块的另一段即切换（编辑 / 阅读、篇目 / 大纲）；按住时有反馈（按另一段文字变淡、按当前段滑块微缩），松开后恢复',
        r08m.read === 'read' && r08m.stillRead === 'read' && r08m.edit === 'edit' && r08m.outline === 'outline' && r08m.files === 'files' &&
          r08m.pressOther.pressed && r08m.pressSame.pressing && !r08m.after.pressing && !r08m.after.pressed,
        r08m)

      // AC-R10 源码模式下滑块停在「编辑」；点「阅读」进入阅读且内容正确
      await js(`T.click('.titlebar [data-cmd=source]'); await T.sleep(300); return true`)
      const r10a = await js(`return { value: document.querySelector('.mode-switch').dataset.value, sourceOn: document.querySelector('.titlebar [data-cmd=source]').classList.contains('active'), src: document.getElementById('source').value }`)
      await js(`document.getElementById('source').value = document.getElementById('source').value + '\\n\\n源码中追加的一段\\n'; document.getElementById('source').dispatchEvent(new Event('input')); await T.sleep(400); return true`)
      await toMode('read')
      const r10b = await js(`return { mode: window.__test.state.mode, has: [...document.querySelectorAll('.prose p')].some(p => p.textContent === '源码中追加的一段') }`)
      await toMode('edit')
      check('AC-R10', '源码模式下滑块停在「编辑」且「源码」按钮按下；点「阅读」进入阅读模式且内容正确', r10a.value === 'edit' && r10a.sourceOn && r10b.mode === 'read' && r10b.has, { r10a: { ...r10a, src: undefined }, r10b })
      fake.boxAnswer = 1
      await js(`window.__test.loadDoc({}); return true`)

      // =================== v1.4：GitHub 风格文档（§8d） ===================
      const ghDir = path.join(tmpDir, 'github')
      fs.cpSync(path.join(__dirname, '..', 'samples', 'github'), ghDir, { recursive: true })
      const G = (n) => path.join(ghDir, n)
      const ghSrc = fs.readFileSync(G('README.md'), 'utf8')
      const nl = (t) => t.replace(/\r\n/g, '\n').trim()
      await toMode('edit')
      await js(`document.body.dataset.pwned = ''; return true`)
      await loadFile(G('README.md'))
      await wait(600)

      // AC-G01 往返保真：不改 → 逐字一致；改一段 → 只有这一段变化；全部重新生成 → 链接、图片、HTML 都不丢
      const g01 = await js(`
        const same = T.md()
        const p = [...document.querySelectorAll('.prose p')].find(p => p.textContent.startsWith('这张图展示了全部路线'))
        const pos = T.e().view.posAtDOM(p, 0) + p.textContent.length
        T.e().chain().setTextSelection(pos).insertContent('（补充）').run()
        await T.sleep(400)
        const edited = T.md()
        const regen = T.e().storage.markdown.getMarkdownPlain()
        T.e().commands.undo(); await T.sleep(500)
        return { same, edited, regen, dirtyAfterUndo: T.dirty() }`)
      const g01diff = (() => {
        const a = nl(ghSrc).split('\n')
        const b = nl(g01.edited).split('\n')
        return { lenSame: a.length === b.length, changed: a.map((l, i) => (l === b[i] ? null : [l, b[i]])).filter(Boolean) }
      })()
      const must = [
        '[第一站：起步](stages/01-起步.md)', '[名词表](stages/02-名词表.md#核心名词)', '[![License](img/徽章.svg)](LICENSE)',
        '![横幅：从零到一的路线图](img/横幅.svg)\n\n# 示例项目', '外部资料见 https://example.com/guide 或 <https://example.com/faq>',
        '<a name="top"></a>', '<img src="img/徽章.svg" width="60">', '<span title="提示">带标签的文字</span>', '<div align="center" markdown="1">',
        '<details open>', '<!-- 这是一条注释，不应显示在阅读模式中 -->', '<th scope="rowgroup" rowspan="2">开始</th>', '[demo@example.com](mailto:demo@example.com)',
      ]
      const missing = must.filter((t) => !g01.regen.includes(t))
      check('AC-G01', 'GitHub 风格文档往返保真：不改时逐字一致；只改一段时其余部分逐字不变；整篇重新生成时链接、徽章、图片、HTML、裸网址都不丢',
        nl(g01.same) === nl(ghSrc) && g01diff.lenSame && g01diff.changed.length === 1 && g01diff.changed[0][1].endsWith('下面逐一说明。（补充）') &&
          missing.length === 0 && !g01.dirtyAfterUndo,
        { same: nl(g01.same) === nl(ghSrc), changed: g01diff.changed, missing, dirtyAfterUndo: g01.dirtyAfterUndo })

      // AC-G02 带文件夹的相对链接是链接，阅读模式单击打开；危险链接不生成
      const g02 = await js(`
        const a = [...document.querySelectorAll('.prose a')].find(a => a.textContent === '第一站：起步')
        const before = T.e().state.doc.textContent.length
        T.e().chain().focus('end').insertContent('X').run()
        const end = T.e().state.selection.from
        const set = T.e().chain().setTextSelection({ from: end - 1, to: end }).setLink({ href: 'javascript:alert(1)' }).run()
        const bad = !!document.querySelector('.prose a[href^="javascript"]')
        T.e().commands.undo(); await T.sleep(300)
        return { href: a?.getAttribute('href'), color: a ? getComputedStyle(a).color : null, link: getComputedStyle(document.documentElement).getPropertyValue('--link').trim(), set, bad }`)
      await toMode('read')
      await clickLink('第一站：起步')
      const g02open = (await cur()).path
      await js(`await window.__test.gotoFile(${JSON.stringify(G('README.md'))}); await T.sleep(500); return true`)
      check('AC-G02', '带文件夹的相对链接显示为链接，阅读模式单击打开对应文件；javascript: 链接不会生成',
        g02.href === 'stages/01-起步.md' && g02open === G('stages/01-起步.md') && !g02.bad, { ...g02, g02open })

      // AC-G03 同一段中的徽章横排，徽章的链接可用
      const g03 = await js(`
        const p = [...document.querySelectorAll('.prose p')].find(p => p.querySelectorAll('img:not(.ProseMirror-separator)').length === 3)
        const imgs = p ? [...p.querySelectorAll('img:not(.ProseMirror-separator)')] : []
        const tops = imgs.map(i => Math.round(i.getBoundingClientRect().top))
        return { n: imgs.length, tops, href: imgs[0]?.closest('a')?.getAttribute('href'), loaded: imgs.every(i => i.complete && i.naturalWidth > 0) }`)
      check('AC-G03', '同一段落中的 3 个徽章排成一行；第一个徽章带链接 LICENSE；图片都能显示',
        g03.n === 3 && new Set(g03.tops).size === 1 && g03.href === 'LICENSE' && g03.loaded, g03)

      // AC-G04 完整的 HTML 块直接渲染
      const g04 = await js(`
        const right = [...document.querySelectorAll('.prose .html-render div[align="right"]')][0]
        return { table: !!document.querySelector('.prose .html-render table th[rowspan="2"]'), rows: document.querySelectorAll('.prose .html-render table tbody tr').length,
          right: right ? getComputedStyle(right).textAlign : null, links: right ? [...right.querySelectorAll('a')].map(a => a.getAttribute('href')) : [],
          centerImg: !!document.querySelector('.prose .html-render p[align="center"] img[width="120"]'),
          inlineImg: !!document.querySelector('.prose .html-inline.rendered img[width="60"]') }`)
      check('AC-G04', '完整 HTML 块直接渲染：HTML 表格（含 rowspan）、右对齐的链接、居中的图片、行内 <img width>',
        g04.table && g04.rows === 2 && g04.right === 'right' && g04.links.join(',') === './README.md,./stages/01-起步.md' && g04.centerImg && g04.inlineImg, g04)

      // AC-G05 包裹标签：编辑模式为小标签，阅读模式隐藏；align 生效
      const chipInfo = () => js(`
        const chips = [...document.querySelectorAll('.prose .html-block[data-kind="chip"]')]
        const h1 = document.querySelector('.prose h1')
        const anchorP = [...document.querySelectorAll('.prose p.html-only')]
        return { n: chips.length, maxH: Math.max(...chips.map(c => c.getBoundingClientRect().height)), visible: chips.filter(c => c.offsetParent !== null).length,
          h1: h1 ? getComputedStyle(h1).textAlign : null, anchorVisible: anchorP.filter(p => p.offsetParent !== null).length, anchorN: anchorP.length }`)
      const g05read = await chipInfo()
      await toMode('edit')
      const g05edit = await chipInfo()
      check('AC-G05', '包裹标签与注释：编辑模式下为单行小标签（高 ≤ 28px），阅读模式下不可见；<div align="center"> 内的标题居中；只含 <a name> 的段落阅读时不占行',
        g05edit.n === 5 && g05edit.visible === g05edit.n && g05edit.maxH <= 28 && g05read.visible === 0 && g05read.h1 === 'center' && g05read.anchorN === 1 && g05read.anchorVisible === 0,
        { g05edit, g05read })

      // AC-G06 <details>：阅读模式默认折叠，单击展开 / 收起；<details open> 默认展开；编辑模式始终展开
      const vis = (text) => `(() => { const el = [...document.querySelectorAll('.prose p, .prose pre')].find(e => e.textContent.includes(${JSON.stringify(text)})); return !!el && el.offsetParent !== null })()`
      const g06 = { edit: await js(`return ${vis('git clone')}`) }
      await toMode('read')
      g06.readInit = await js(`return { clone: ${vis('git clone')}, open: ${vis('这一段默认是展开的')} }`)
      await js(`[...document.querySelectorAll('.prose .html-summary')].find(r => r.textContent.includes('下载到本机')).click(); await T.sleep(300); return true`)
      g06.afterOpen = await js(`return ${vis('git clone')}`)
      await js(`[...document.querySelectorAll('.prose .html-summary')].find(r => r.textContent.includes('下载到本机')).click(); await T.sleep(300); return true`)
      g06.afterClose = await js(`return ${vis('git clone')}`)
      check('AC-G06', '<details> 阅读模式默认折叠、单击展开再单击收起；<details open> 默认展开；编辑模式始终展开',
        g06.edit && !g06.readInit.clone && g06.readInit.open && g06.afterOpen && !g06.afterClose, g06)

      // AC-G07 安全：HTML 中的脚本、事件属性、iframe、javascript: 链接、style 都不生效
      const g07 = await js(`
        await T.sleep(300)
        const r = document.querySelector('.prose')
        return { pwned: document.body.dataset.pwned || '', script: r.querySelectorAll('script').length, handlers: r.querySelectorAll('[onclick],[onerror],[onload]').length,
          styled: r.querySelectorAll('.html-render [style], .html-inline [style]').length, jsLink: r.querySelectorAll('a[href^="javascript"]').length,
          mask: [...r.querySelectorAll('.html-render span')].some(s => s.textContent === '遮罩' && getComputedStyle(s).position === 'fixed') }`)
      check('AC-G07', 'HTML 中的 <script>、onerror/onclick、javascript: 链接、style 属性都不生效', !g07.pwned && !g07.script && !g07.handlers && !g07.styled && !g07.jsLink && !g07.mask, g07)
      await toMode('edit')

      // AC-G08 格式栏底衬
      const g08 = await js(`
        const w = document.querySelector('.formatbar-wrap'); const b = getComputedStyle(w, '::before')
        return { content: b.content, bg: b.backgroundImage.slice(0, 40), bottom: b.bottom, z: b.zIndex }`)
      check('AC-G08', '格式栏后方有纸面同色底衬，下沿 12px 渐隐（正文不会从胶囊上方露出）',
        g08.content !== 'none' && /gradient/.test(g08.bg) && g08.bottom === '-12px', g08)
      await js(`window.__test.loadDoc({}); return true`)

      // =================== v1.6：单个换行、流程图（§8f）；撤销不越过「打开」（AC-F19） ===================
      const wDir = path.join(tmpDir, '笔记')
      fs.cpSync(path.join(__dirname, '..', 'samples', '笔记'), wDir, { recursive: true })
      const wFile = path.join(wDir, '流程与换行.md')
      const wSrc = fs.readFileSync(wFile, 'utf8')
      await toMode('edit')
      // AC-W07 按需载入：此前打开的文档都没有流程图，组件不应已载入
      const w07 = { before: await js(`return window.__mermaidLoaded === true`) }
      await loadFile(wFile)
      await wait(1500)
      await js(`window.__W = {
        at: (s, starts) => { let at = -1; T.e().state.doc.descendants((n, pos) => { if (at < 0 && n.isText && (starts ? n.text.startsWith(s) : n.text.includes(s))) at = pos + (starts ? 0 : n.text.indexOf(s)) }); return at },
        para: (s) => [...document.querySelectorAll('.prose p')].find(p => p.textContent.startsWith(s)),
        paraEnd: (s) => { let end = -1; T.e().state.doc.descendants((n, pos) => { if (n.type.name === 'paragraph' && n.textContent.startsWith(s)) end = pos + n.nodeSize - 1 }); return end },
        out: () => { T.e().commands.setTextSelection(__W.at('名称', true)) },
        preH: () => [...document.querySelectorAll('.prose pre.mermaid-src')].map(p => Math.round(p.getBoundingClientRect().height)),
      }; return true`)
      w07.after = await js(`return window.__mermaidLoaded === true`)
      w07.remote = await js(`return performance.getEntriesByType('resource').filter(e => /^https?:/.test(e.name)).map(e => e.name)`)

      // AC-W01 单个换行显示为换行
      const w01 = await js(`const p = __W.para('名称'), lh = parseFloat(getComputedStyle(p).lineHeight)
        return { soft: p.querySelectorAll('br[data-soft]').length, lines: Math.round(p.getBoundingClientRect().height / lh),
          li: [...document.querySelectorAll('.prose ol li')].map(li => li.querySelectorAll('br[data-soft]').length),
          hard: __W.para('第一行').querySelectorAll('br:not([data-soft])').length }`)
      await toMode('read')
      w01.read = await js(`const p = __W.para('名称'); return { soft: p.querySelectorAll('br[data-soft]').length, h: Math.round(p.getBoundingClientRect().height) }`)
      await toMode('edit')
      check('AC-W01', '段落里一行一条写的 4 行显示为 4 行（3 处换行），列表项下缩进的续行另起一行；阅读模式一致；Shift+Enter 的换行照样显示',
        w01.soft === 3 && w01.lines === 4 && w01.li.length === 2 && w01.li.every((n) => n === 1) && w01.hard === 1 && w01.read.soft === 3, w01)

      // AC-W02 原文不变；改过的段落仍写单个换行；Shift+Enter 写为 \ + 换行
      const w02 = await js(`const same = T.md()
        T.e().view.dispatch(T.e().state.tr.insertText('（已核对）', __W.paraEnd('名称'))); await T.sleep(400)
        const edited = T.md()
        T.e().commands.undo(); await T.sleep(300)
        T.e().chain().setTextSelection(__W.paraEnd('一行一条')).setHardBreak().insertContent('X').run(); await T.sleep(400)
        const hard = T.md()
        T.e().commands.undo(); T.e().commands.undo(); await T.sleep(400)
        return { same, edited, hard, back: T.md(), dirty: T.dirty() }`)
      const w02exp = wSrc.replace('状态：采集中\r\n', '状态：采集中（已核对）\r\n')
      check('AC-W02', '不修改时逐字一致（Windows 换行）；在一行一条的段落末尾加字后，这一段仍是单个换行、其他部分逐字不变；Shift+Enter 写为 \\ + 换行',
        w02.same === wSrc && w02.edited === w02exp && w02.hard.includes('中间没有空行。\\\r\nX') && w02.back === wSrc && !w02.dirty,
        { same: w02.same === wSrc, edited: w02.edited === w02exp, editedPart: w02.edited.split('## 采集点信息')[1]?.slice(0, 80), hard: w02.hard.includes('中间没有空行。\\\r\nX'), back: w02.back === wSrc, dirty: w02.dirty })

      // AC-W03 流程图显示；单击图展开代码；改字后图跟着更新；光标移出收起
      const w03 = {}
      w03.view = await js(`const v = [...document.querySelectorAll('.mermaid-view')]
        return { n: v.length, svg: v.map(x => !!x.querySelector('svg')), text: v[0]?.innerText || '', seq: v[1]?.innerText || '', label: getComputedStyle(v[0], '::before').content, preH: __W.preH() }`)
      await toMode('read')
      w03.read = await js(`return { preH: __W.preH(), svgs: document.querySelectorAll('.mermaid-view svg').length, label: getComputedStyle(document.querySelector('.mermaid-view'), '::before').content }`)
      await toMode('edit')
      const wb = await js(`const v = document.querySelector('.mermaid-view'); v.scrollIntoView({ block: 'center' }); await T.sleep(250); const r = v.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`)
      ensureVisible()
      win.webContents.sendInputEvent({ type: 'mouseDown', x: wb.x, y: wb.y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: wb.x, y: wb.y, button: 'left', clickCount: 1 })
      await wait(400)
      w03.click = await js(`const p = document.querySelector('.prose pre.mermaid-src'); return { editing: p.classList.contains('mermaid-editing'), h: Math.round(p.getBoundingClientRect().height), inCode: T.e().isActive('codeBlock'), dirty: T.dirty() }`)
      const w03t = Date.now()
      await js(`const at = __W.at('开始'); T.e().view.dispatch(T.e().state.tr.insertText('出发', at, at + 2)); return true`)
      w03.keep = await js(`return !!document.querySelector('.mermaid-view svg')`)
      w03.ms = null
      for (let i = 0; i < 40; i++) {
        await wait(50)
        if (await js(`return document.querySelector('.mermaid-view').innerText.includes('出发')`)) { w03.ms = Date.now() - w03t; break }
      }
      await js(`__W.out(); await T.sleep(200); return true`)
      w03.leave = await js(`return __W.preH()`)
      check('AC-W03', '流程图显示为图（含「开始」「是否通过」），时序图同样为图；阅读模式只有图；编辑模式默认只有图、右上角「流程图」；真实鼠标单击图 → 代码展开、光标在代码里；改「开始」为「出发」→ 约 0.5 秒内图更新且期间图不消失；光标移出 → 代码收起',
        w03.view.n === 3 && w03.view.svg.every(Boolean) && /开始/.test(w03.view.text) && /是否通过/.test(w03.view.text) && /上报任务/.test(w03.view.seq) &&
          w03.view.label.includes('流程图') && w03.view.preH.every((h) => h === 0) && w03.read.preH.every((h) => h === 0) && w03.read.svgs === 3 && w03.read.label === 'none' &&
          w03.click.editing && w03.click.h > 0 && w03.click.inCode && !w03.click.dirty && w03.keep && w03.ms !== null && w03.ms <= 700 && w03.leave.every((h) => h === 0),
        w03)

      // AC-W04 撤销恢复原文；源码模式看到原来的代码
      const w04 = await js(`T.e().commands.undo(); await T.sleep(800); return { same: T.md() === ${JSON.stringify(wSrc)}, dirty: T.dirty(), svg: document.querySelector('.mermaid-view').innerText.includes('开始') }`)
      w04.source = await js(`T.click('.titlebar [data-cmd=source]'); await T.sleep(300); const v = document.getElementById('source').value
        T.click('.titlebar [data-cmd=source]'); await T.sleep(600); return v.includes('A[开始] --> B{是否通过}') && v.includes('sequenceDiagram')`)
      w04.after = await js(`return { same: T.md() === ${JSON.stringify(wSrc)}, dirty: T.dirty() }`)
      check('AC-W04', '流程图修改后 Ctrl+Z 恢复原文且不再是未保存；源码模式看到原来的代码，切回后仍逐字一致',
        w04.same && !w04.dirty && w04.svg && w04.source && w04.after.same && !w04.after.dirty, w04)

      // AC-W05 写错时显示提示、代码保持展开；不弹窗、控制台无错误；改回恢复
      const w05 = { errs: consoleErrors.length, boxes: fake.box.length }
      await js(`await T.sleep(300); const at = __W.at('flowchart LR', true); T.e().view.dispatch(T.e().state.tr.insertText('flowchart ???', at, at + 12)); return true`)
      await wait(1200)
      w05.err = await js(`const v = document.querySelector('.mermaid-view'); return { msg: v.innerText, state: v.dataset.state }`)
      await js(`__W.out(); await T.sleep(200); return true`)
      w05.preH = await js(`return __W.preH()[0]`)
      await js(`T.e().commands.undo(); await T.sleep(1200); return true`)
      w05.fixed = await js(`return { svg: !!document.querySelector('.mermaid-view svg'), same: T.md() === ${JSON.stringify(wSrc)}, dirty: T.dirty(), preH: __W.preH()[0] }`)
      w05.errs = consoleErrors.length - w05.errs
      w05.boxes = fake.box.length - w05.boxes
      check('AC-W05', '流程图写错：图的位置提示「流程图有误：…」，光标移出后代码仍展开；不弹窗、控制台无错误；撤销后恢复成图',
        w05.err.msg.startsWith('流程图有误：') && w05.err.state === 'error' && w05.preH > 0 && w05.errs === 0 && w05.boxes === 0 &&
          w05.fixed.svg && w05.fixed.same && !w05.fixed.dirty && w05.fixed.preH === 0,
        w05)

      // AC-W06 安全：click 回调、javascript: 链接、onerror 都不生效
      const w06 = await js(`const v = [...document.querySelectorAll('.mermaid-view')][2]
        return { pwned: window.__pwned || null, text: v.innerText, img: v.querySelectorAll('img, [onerror], [onclick]').length, js: v.querySelectorAll('a[href^="javascript"], a[*|href^="javascript"]').length, foreign: v.querySelectorAll('foreignObject').length }`)
      check('AC-W06', '流程图里的 click 回调、javascript: 链接、带 onerror 的 HTML 标签都不执行，不在图里生成元素；不请求任何网络资源',
        !w06.pwned && /危险/.test(w06.text) && w06.img === 0 && w06.js === 0 && w07.remote.length === 0, { ...w06, remote: w07.remote })
      check('AC-W07', '打开不含流程图的文档时不载入流程图组件；打开含流程图的文档后才载入，且不需要联网', !w07.before && w07.after && w07.remote.length === 0, w07)

      // AC-F19 撤销不越过「打开」：打开后连按 Ctrl+Z 不变；在 A 改字后换到 B，连按 Ctrl+Z，B 不变
      const f19 = {}
      await loadFile(wFile)
      await js(`T.e().commands.focus('start'); return true`)
      for (let i = 0; i < 3; i++) await key('Z', ['control'])
      await wait(300)
      f19.load = await js(`return { same: T.md() === ${JSON.stringify(wSrc)}, dirty: T.dirty() }`)
      await js(`T.e().view.dispatch(T.e().state.tr.insertText('【A 的修改】', 3)); await T.sleep(300); return true`)
      await loadFile(G('stages/01-起步.md'))
      const f19b = await js(`return T.md()`)
      await js(`T.e().commands.focus('start'); return true`)
      for (let i = 0; i < 4; i++) await key('Z', ['control'])
      await wait(300)
      f19.switch = await js(`return { same: T.md() === ${JSON.stringify(f19b)}, dirty: T.dirty(), hasA: T.md().includes('A 的修改') }`)
      check('AC-F19', '打开文件后连按 Ctrl+Z 内容不变、不变成空白；在 A 篇改字后换到 B 篇，连按 Ctrl+Z，B 篇不变、不出现未保存',
        f19.load.same && !f19.load.dirty && f19.switch.same && !f19.switch.dirty && !f19.switch.hasA, f19)
      await js(`window.__test.loadDoc({}); return true`)

      // =================== 第三部分：保存与确认流程（模拟对话框） ===================
      const doc = () => js(`return { name: document.getElementById('docName').textContent, dirty: T.dirty(), md: T.md(), path: window.__test.state.path }`)
      const edit = (t) => js(`T.e().chain().focus('end').insertContent(${JSON.stringify(t)}).run(); await T.sleep(400); return true`)

      // AC-F08 新文档 Ctrl+S → 另存为对话框，默认名「未命名.md」
      // 只覆盖「没有打开文件夹」的情况；已打开文件夹时直接存进该文件夹（AC-F22），先解除文件夹
      await js(`await window.__test.folderNav.setDir(null); await T.sleep(200); return true`)
      fake.boxAnswer = 1 // 上一步留下的修改选择「不保存」
      await menuKey('CmdOrCtrl+N')
      await wait(300)
      await edit('新文档内容')
      fake.saveAnswer = path.join(tmpDir, '新文档.md')
      fake.save = []
      await menuKey('CmdOrCtrl+S')
      await wait(600)
      let d = await doc()
      check('AC-F08', '没有打开文件夹时新文档保存弹出另存为，默认「未命名.md」，保存后显示新文件名',
        fake.save[0] === '未命名.md' && fs.existsSync(fake.saveAnswer) && d.name === '新文档.md' && !d.dirty,
        { calls: fake.save, name: d.name, dirty: d.dirty })

      // AC-F09 Ctrl+Shift+S 总是弹出；之后 Ctrl+S 写入新路径
      fake.saveAnswer = path.join(tmpDir, '另存.md')
      fake.save = []
      await menuKey('CmdOrCtrl+Shift+S')
      await wait(600)
      await edit('追加')
      await menuKey('CmdOrCtrl+S')
      await wait(600)
      d = await doc()
      check('AC-F09', '另存为总是弹出对话框，之后保存写入新路径',
        fake.save.length === 1 && d.name === '另存.md' && fs.readFileSync(fake.saveAnswer, 'utf8').includes('追加') &&
          !fs.readFileSync(path.join(tmpDir, '新文档.md'), 'utf8').includes('追加'),
        { calls: fake.save, name: d.name })

      // AC-F10 有未保存修改时新建/打开：取消 / 不保存 / 保存
      const f10 = {}
      await edit('未保存修改')
      fake.box = []
      fake.boxAnswer = 2
      await menuKey('CmdOrCtrl+N')
      await wait(400)
      d = await doc()
      f10.cancelNew = fake.box.length === 1 && d.dirty && d.md.includes('未保存修改')
      fake.open = 0
      await menuKey('CmdOrCtrl+O')
      await wait(400)
      d = await doc()
      f10.cancelOpen = fake.box.length === 2 && fake.open === 0 && d.dirty
      fake.boxAnswer = 1
      await menuKey('CmdOrCtrl+N')
      await wait(400)
      d = await doc()
      f10.discard = !d.dirty && d.md.trim() === '' && d.name === '未命名.md'
      await edit('要保存的内容')
      // 这条走「没有打开文件夹」的保存框分支；打开文件夹时直接存入，见 AC-F22
      await js(`await window.__test.folderNav.setDir(null); await T.sleep(200); return true`)
      fake.boxAnswer = 0
      fake.saveAnswer = path.join(tmpDir, 'f10.md')
      await menuKey('CmdOrCtrl+N')
      await wait(700)
      d = await doc()
      f10.saveThenNew =
        fs.existsSync(fake.saveAnswer) && fs.readFileSync(fake.saveAnswer, 'utf8').includes('要保存的内容') && d.name === '未命名.md' && d.md.trim() === ''
      check('AC-F10', '未保存时新建/打开：取消不变、不保存丢弃、保存后继续', Object.values(f10).every(Boolean), f10)

      // AC-F11 有未保存修改时关闭窗口：取消 → 不关；保存但在另存为中取消 → 不关
      // 同样按「没有打开文件夹」测保存框（打开文件夹时新文档直接存入，见 AC-F22）
      const f11 = {}
      await js(`await window.__test.folderNav.setDir(null); await T.sleep(200); return true`)
      await edit('关闭测试')
      fake.box = []
      fake.boxAnswer = 2
      win.close()
      await wait(500)
      f11.cancelKeepsOpen = !win.isDestroyed() && fake.box.length === 1
      fake.boxAnswer = 0
      fake.saveAnswer = null
      win.close()
      await wait(700)
      f11.saveCanceledKeepsOpen = !win.isDestroyed() && fake.box.length === 2
      check('AC-F11', '未保存时关闭：取消不关闭；另存为中取消也不关闭', Object.values(f11).every(Boolean), f11)

      // AC-F12 没有修改时关闭窗口 → 直接关闭（用新窗口验证）
      const before = BrowserWindow.getAllWindows().length
      fake.box = []
      await menuKey('CmdOrCtrl+Shift+N')
      await wait(2000)
      const w2 = BrowserWindow.getAllWindows().find((w) => w !== win)
      let closed = false
      let f01Banner = null
      if (w2) {
        // AC-F01 不带文件启动：空白「未命名.md」、光标在正文、显示占位提示
        const f01 = await w2.webContents.executeJavaScript(`(() => {
          const p = document.querySelector('.prose p.is-editor-empty')
          return {
            name: document.getElementById('docName').textContent,
            focused: window.__editor.isFocused,
            placeholder: p ? getComputedStyle(p, '::before').content : null,
            text: window.__editor.getText().slice(0, 80),
            dirty: window.__test.state.dirty,
            path: window.__test.state.path,
            banner: !!document.querySelector('.draft-banner'),
            wins: ${BrowserWindow.getAllWindows().length},
          }
        })()`)
        check('AC-F01', '不带文件启动显示空白「未命名.md」，光标在正文，有占位提示',
          f01.name === '未命名.md' && f01.focused && f01.placeholder === '"开始输入…"', f01)
        f01Banner = f01.banner
        w2.on('closed', () => (closed = true))
        w2.close()
        await wait(800)
      }
      check('AC-F12', '没有修改时关闭窗口直接关闭，不弹窗',
        !!w2 && closed && fake.box.length === 0 && BrowserWindow.getAllWindows().length === before, { opened: !!w2, closed, box: fake.box.length })
      // AC-F16b 主窗口是有未保存修改的「未命名」：新开的「未命名」窗口不提示恢复它的内容，也不会清掉它的草稿
      {
        const mainDirty = await js(`return { dirty: T.dirty(), path: window.__test.state.path, md: T.md() }`)
        const ddir = path.join(outDir, 'userdata', 'drafts')
        const kept = fs.readdirSync(ddir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(ddir, f), 'utf8')))
          .some((d) => String(d.key).startsWith('draft:untitled:') && d.md === mainDirty.md)
        check('AC-F16b', '两个窗口都是「未命名」时，新窗口不提示恢复另一个窗口正在编辑的内容，也不会清掉它的草稿',
          mainDirty.dirty && !mainDirty.path && f01Banner === false && kept, { dirty: mainDirty.dirty, banner: f01Banner, draftKept: kept })
      }
      check('AC-D06', 'Ctrl+Shift+N 新建窗口', !!w2, null)

      // AC-F16 新文档（从未保存）崩溃后重新打开 → 出现草稿提示
      await menuKey('CmdOrCtrl+Shift+N')
      await wait(2000)
      const w3 = BrowserWindow.getAllWindows().find((w) => w !== win)
      let f16 = { opened: !!w3 }
      if (w3) {
        await injectT(w3.webContents)
        await w3.webContents.executeJavaScript(`(async () => { T.e().commands.insertContent('未保存的新文档'); await T.sleep(800); return true })()`)
        await reload({ crash: true, wc: w3.webContents })
        f16 = await w3.webContents.executeJavaScript(`(async () => {
          const bar = document.querySelector('.draft-banner')
          const r = { opened: true, banner: !!bar }
          bar?.querySelector('[data-a=restore]').click(); await T.sleep(500)
          r.restored = T.md().includes('未保存的新文档'); r.dirty = T.dirty()
          // 清理：撤回到空白并丢弃草稿
          window.__test.loadDoc({}); await T.sleep(300)
          document.querySelector('.draft-banner [data-a=drop]')?.click(); await T.sleep(300)
          return r
        })()`)
        fake.box = []
        w3.close()
        await wait(800)
      }
      check('AC-F16', '新文档未保存时崩溃，重新打开出现草稿提示并可恢复', f16.opened && f16.banner && f16.restored && f16.dirty, f16)

      // AC-F11（保存分支）：保存成功后窗口关闭 —— 最后执行
      win.focus()
      fake.boxAnswer = 0
      fake.saveAnswer = path.join(tmpDir, '关闭前保存.md')
      results.push({ id: 'AC-F11b', desc: '未保存时关闭选「保存」：保存成功后窗口关闭', pass: false, detail: '窗口未关闭' })
      win.on('closed', () => {
        const ok = fs.existsSync(fake.saveAnswer) && fs.readFileSync(fake.saveAnswer, 'utf8').includes('关闭测试')
        results[results.findIndex((r) => r.id === 'AC-F11b')] = { id: 'AC-F11b', desc: '未保存时关闭选「保存」：保存成功后窗口关闭', pass: ok, detail: null }
        finish()
      })
    } catch (err) {
      results.push({ id: 'ERROR', desc: '自测脚本异常', pass: false, detail: String((err && err.stack) || err) })
    }
    let finished = false
    function finish() {
      if (finished) return
      finished = true
      check('AC-P06', '控制台无错误', consoleErrors.length === 0, consoleErrors)
      results.push({ id: 'INFO', desc: '输入方式与截图记录', pass: true, detail: { 键盘: inputStats, 截图失败: shotNotes } })
      fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2))
      const passed = results.filter((r) => r.pass).length
      console.log(`\n自测完成：${passed}/${results.length} 通过`)
      for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.id} ${r.desc}${r.pass ? '' : '\n   ' + JSON.stringify(r.detail).slice(0, 600)}`)
      app.exit(0)
    }
    if (results.some((r) => r.id === 'AC-F11b') && !results.some((r) => r.id === 'ERROR')) {
      win.close() // 触发「保存」分支，保存完成后窗口关闭并调用 finish()
      setTimeout(finish, 5000) // 兜底
    } else finish()
  })
})
