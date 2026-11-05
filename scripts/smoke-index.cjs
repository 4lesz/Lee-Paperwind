// 翻页索引的快速检查（不发送真实按键，不影响正在使用电脑）：npx electron scripts/smoke-index.cjs <输出目录>
const { app, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const outDir = path.resolve(process.argv[process.argv.length - 1])
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
app.setPath('userData', path.join(outDir, 'userdata'))
const boxes = []
dialog.showMessageBox = async (_w, o) => (boxes.push(o.message), { response: 1 })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
require('../electron/main.cjs')
let started = false
app.on('browser-window-created', (_e, win) => {
  if (started) return
  started = true
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`)
    const out = {}
    try {
      await wait(1200)
      const dir = path.join(outDir, '索引')
      fs.cpSync(path.join(__dirname, '..', 'samples', '索引'), dir, { recursive: true })
      const P = (n) => path.join(dir, n)
      const pager = () =>
        js(`return [...document.querySelectorAll('#pager .pager-slot, #pager .pager-gap')].map(s => s.classList.contains('pager-gap') ? 'gap' :
          (s.querySelector('.pager-card').className.replace('pager-card','').trim() + '|' + s.querySelector('.pager-label').textContent.trim() + '|' + s.querySelector('.pager-title').textContent.trim() + (s.querySelector('.pager-edit') ? '|✎' : '')))`)
      await js(`await window.__test.openFolder(${JSON.stringify(dir)}); await new Promise(r => setTimeout(r, 600)); return 1`)
      for (const f of ['01-甲.md', '02-乙.md', '05-戊.md', '06-己.md', '子/03-丙.md', '子/04-丁.md']) {
        await js(`await window.__test.gotoFile(${JSON.stringify(P(f))}, { turn: false }); await new Promise(r => setTimeout(r, 500)); return 1`)
        const r = await js(`return { md: window.__editor.storage.markdown.getMarkdown(), first: window.__editor.state.doc.firstChild.type.name, chip: document.querySelector('.front-matter-chip')?.textContent || null, hr: document.querySelectorAll('.prose hr').length }`)
        const src = fs.readFileSync(P(f), 'utf8')
        out[f] = { same: r.md === src, first: r.first, chip: r.chip, hr: r.hr, pager: await pager() }
        if (!out[f].same) out[f].md = JSON.stringify(r.md)
      }
      // 阅读模式
      await js(`document.querySelector('.mode-switch .seg-item[data-value=read]').click(); await new Promise(r => setTimeout(r, 300)); return 1`)
      out.readMode = { pager: await pager(), chipVisible: await js(`const c = document.querySelector('.front-matter'); return !!c && c.getBoundingClientRect().height > 0`) }
      await js(`document.querySelector('.mode-switch .seg-item[data-value=edit]').click(); await new Promise(r => setTimeout(r, 300)); return 1`)
      // 在乙上指定下一篇 → 丙；撤销；再指定；恢复默认
      await js(`await window.__test.gotoFile(${JSON.stringify(P('02-乙.md'))}, { turn: false }); await new Promise(r => setTimeout(r, 500)); return 1`)
      await js(`document.querySelector('#pager .pager-slot[data-side=next] .pager-edit').click(); await new Promise(r => setTimeout(r, 400)); return 1`)
      out.picker = await js(`return { title: document.querySelector('.modal-title')?.textContent, items: [...document.querySelectorAll('.pick-item')].map(li => li.querySelector('.pick-title').textContent + '|' + li.querySelector('.pick-sub').textContent + (li.classList.contains('disabled') ? '|禁用' : '') + (li.classList.contains('current') ? '|✓' : '')), buttons: [...document.querySelectorAll('.pick-modal .btn')].map(b => b.textContent) }`)
      fs.writeFileSync(path.join(outDir, 'picker.png'), (await win.webContents.capturePage()).toPNG())
      await js(`document.querySelector('.pick-folder[data-key="子"]')?.click(); await new Promise(r => setTimeout(r, 200)); document.querySelector('.pick-item[data-key="子/03-丙.md"]').click(); await new Promise(r => setTimeout(r, 500)); [...document.querySelectorAll('.ask-modal .btn')].find(b => b.textContent === '保留原来的')?.click(); await new Promise(r => setTimeout(r, 400)); return 1`)
      out.afterPick = { md: await js(`return window.__editor.storage.markdown.getMarkdown()`), dirty: await js(`return window.__test.state.dirty`), pager: await pager() }
      await js(`window.__editor.commands.undo(); await new Promise(r => setTimeout(r, 500)); return 1`)
      out.afterUndo = { same: (await js(`return window.__editor.storage.markdown.getMarkdown()`)) === fs.readFileSync(P('02-乙.md'), 'utf8'), dirty: await js(`return window.__test.state.dirty`), pager: await pager() }
      // 甲：改 next，其他行保留
      await js(`await window.__test.gotoFile(${JSON.stringify(P('01-甲.md'))}, { turn: false }); await new Promise(r => setTimeout(r, 500)); window.__test.applyIndex('next', '02-乙.md'); window.__test.applyIndex('prev', false); await new Promise(r => setTimeout(r, 300)); return 1`)
      out.jia = { md: await js(`return window.__editor.storage.markdown.getMarkdown()`), pager: await pager() }
      // 戊：CRLF
      await js(`await window.__test.gotoFile(${JSON.stringify(P('05-戊.md'))}, { turn: false }); await new Promise(r => setTimeout(r, 500)); return 1`)
      await js(`window.__test.applyIndex('next', '06-己.md'); return 1`)
      out.wu = JSON.stringify(await js(`return window.__editor.storage.markdown.getMarkdown()`))
      // 保护：退格、全选删除不删掉属性区
      await js(`await window.__test.gotoFile(${JSON.stringify(P('子/03-丙.md'))}, { turn: false }); await new Promise(r => setTimeout(r, 500)); return 1`)
      out.guard = await js(`const e = window.__editor
        e.commands.focus(); e.commands.setTextSelection(e.state.doc.firstChild.nodeSize + 1)
        const bs = () => e.view.someProp('handleKeyDown', f => f(e.view, new KeyboardEvent('keydown', { key: 'Backspace' })))
        bs(); bs(); bs()
        const a = e.state.doc.firstChild.type.name
        e.commands.selectAll(); e.commands.deleteSelection()
        const b = e.state.doc.firstChild.type.name, md = e.storage.markdown.getMarkdown()
        return { afterBackspace: a, afterSelectAll: b, md }`)
      await js(`window.__editor.commands.setContent('x', false); window.__test.state.dirty = false; return 1`)
      // 跳转：甲(原文件) Ctrl+] → 丙；丙 上一篇 → 甲
      await js(`const d = await window.api.readFile(${JSON.stringify(P('01-甲.md'))}); window.__test.loadDoc(d); await new Promise(r => setTimeout(r, 500)); await window.__test.goSide('next'); await new Promise(r => setTimeout(r, 1400)); return 1`)
      out.goNext = { path: await js(`return window.__test.state.path`), turn: await js(`return window.__test.pageTurn.stats.last?.dir`) }
      await js(`await window.__test.goSide('prev'); await new Promise(r => setTimeout(r, 1400)); return 1`)
      out.goPrev = { path: await js(`return window.__test.state.path`), turn: await js(`return window.__test.pageTurn.stats.last?.dir`) }
      await js(`const d = await window.api.readFile(${JSON.stringify(P('子/04-丁.md'))}); window.__test.loadDoc(d); await new Promise(r => setTimeout(r, 500)); await window.__test.goSide('next'); return 1`)
      out.missing = { boxes, path: await js(`return window.__test.state.path`) }
      await js(`document.head.insertAdjacentHTML('beforeend', '<style>.pager-edit{opacity:1!important}</style>'); await new Promise(r => setTimeout(r, 200)); return 1`)
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(outDir, 'smoke.png'), img.toPNG())
    } catch (e) {
      out.error = String(e && e.stack || e)
    }
    fs.writeFileSync(path.join(outDir, 'smoke.json'), JSON.stringify(out, null, 2), 'utf8')
    app.exit(0)
  })
})
