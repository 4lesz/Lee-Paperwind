// 性能验收（AC-P01–P05）：npx electron scripts/perf.cjs --mode=p01 --out=test-output/perf
// 每个模式单独启动一次进程，结果写到 <out>/<mode>.json，由 scripts/perf-run.cjs 汇总。
// 测的是仓库里构建好的 dist/（与安装包里的 app.asar 逐字节一致，见交接文档 §7.5）。
const { app, BrowserWindow, Menu, dialog, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : dflt
}
const MODE = opt('mode', 'p02')
const OUT = path.resolve(opt('out', path.join('test-output', 'perf')))
const MINUTES = Number(opt('minutes', '30'))
// P03 必须用真实按键：窗口要抢焦点；其余几项用 showInactive，不打扰正在用电脑的人
const REAL_KEYS = MODE === 'p03'
const userDataDir = path.join(OUT, 'userdata-' + MODE)
fs.mkdirSync(userDataDir, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.setPath('userData', userDataDir)

if (!REAL_KEYS) {
  const show = BrowserWindow.prototype.show
  BrowserWindow.prototype.show = function () {
    if (!this.isVisible()) this.showInactive()
    else show.call(this)
  }
}

// 系统对话框一律不弹（P05 保存副本、跳转前不保存时要用到）
dialog.showMessageBox = async () => ({ response: 1 })
dialog.showSaveDialog = async () => ({ canceled: true })
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
shell.openExternal = async () => {}
shell.showItemInFolder = () => {}
shell.openPath = async () => ''

const creationTime = process.getCreationTime() || Date.now()
let showAt = 0
let firstWindow = false
const consoleErrors = []
const crashes = []

let finished = false
function finish(result) {
  if (finished) return
  finished = true
  const payload = {
    mode: MODE,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    release: require('node:os').release(),
    startedAt: new Date().toISOString(),
    consoleErrors,
    crashes,
    ...result,
  }
  fs.writeFileSync(path.join(OUT, MODE + '.json'), JSON.stringify(payload, null, 2), 'utf8')
  setTimeout(() => app.exit(0), 50)
}

app.on('child-process-gone', (_e, d) => {
  crashes.push({ kind: 'child-process-gone', detail: d })
})

app.on('browser-window-created', (_e, win) => {
  if (firstWindow) return
  firstWindow = true
  win.once('show', () => (showAt = Date.now()))
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level
    const msg = e.message ?? e.params?.message
    if (level === 'error' || level === 3) consoleErrors.push(msg)
  })
  win.webContents.on('render-process-gone', (_x, d) => crashes.push({ kind: 'render-process-gone', detail: d }))
  win.on('unresponsive', () => crashes.push({ kind: 'unresponsive', at: new Date().toISOString() }))
  win.webContents.once('did-finish-load', () => {
    main(win).catch((e) => finish({ error: String((e && e.stack) || e) }))
  })
})

require('../electron/main.cjs')

// ---------------- 通用 ----------------
const js = (win) => (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`)

const waitEditable = async (win, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const ok = await win.webContents.executeJavaScript('!!(window.__editor && window.__editor.isEditable)')
    if (ok) return true
    await wait(5)
  }
  return false
}

const round = (n, d = 1) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d)
const stats = (arr) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
  return {
    n: s.length,
    min: round(s[0]),
    median: round(q(0.5)),
    p95: round(q(0.95)),
    max: round(s[s.length - 1]),
    avg: round(s.reduce((a, b) => a + b, 0) / s.length),
  }
}

// 1MB 样本：标题、段落、各种列表、引用、表格、代码块混合
function makeBigMd(targetBytes, diagramCount = 0) {
  const diagrams = [
    '```mermaid\nflowchart LR\n    A[开始] --> B{是否通过}\n    B -- 是 --> C[完成]\n    B -- 否 --> D[修改]\n    D --> B\n```',
    '```mermaid\nsequenceDiagram\n    运营->>系统: 上报任务\n    系统-->>运营: 返回编号\n```',
  ]
  const parts = []
  let bytes = 0
  let i = 0
  while (bytes < targetBytes) {
    i++
    const chunk = [
      `## 第 ${i} 节 性能样本`,
      '',
      `这是第 ${i} 节。性能验收需要足够长的正文：中文按字排版，English words are counted by word，数字与标点混排。The quick brown fox jumps over the lazy dog. 0123456789。`,
      '',
      '- 无序列表第一项，含 **粗体**、*斜体*、`行内代码` 与 [链接](https://example.com)',
      '- 无序列表第二项，含 ==高亮== 与 ~~删除线~~',
      '  - 嵌套的一项',
      '',
      '1. 有序列表第一项',
      '2. 有序列表第二项',
      '3. 有序列表第三项',
      '',
      '- [ ] 待办事项一',
      '- [x] 已完成事项二',
      '',
      '> 引用段落：用来检查引用块的渲染与保存。',
      '',
      '| 列一 | 列二 | 列三 |',
      '| --- | --- | --- |',
      `| 值 ${i} | 中文内容 | 12345 |`,
      '',
      '```js',
      'function perfSample(n) {',
      '  return n * 2',
      '}',
      '```',
      '',
      `这是第 ${i} 节的结尾段落。`,
      '',
    ].join('\n')
    parts.push(chunk)
    bytes += Buffer.byteLength(chunk, 'utf8')
  }
  if (diagramCount > 0) {
    // 放在靠前的两节之后，打开后马上需要渲染
    parts.splice(2, 0, diagrams[0] + '\n')
    if (diagramCount > 1) parts.splice(parts.length - 2, 0, diagrams[1] + '\n')
  }
  return parts.join('\n')
}

function ensureBigSamples() {
  const dir = path.join(OUT, 'samples')
  fs.mkdirSync(dir, { recursive: true })
  const plain = path.join(dir, 'perf-1mb.md')
  const diag = path.join(dir, 'perf-1mb-diagram.md')
  if (!fs.existsSync(plain)) fs.writeFileSync(plain, makeBigMd(1024 * 1024, 0), 'utf8')
  if (!fs.existsSync(diag)) fs.writeFileSync(diag, makeBigMd(1024 * 1024, 2), 'utf8')
  return {
    plain,
    diag,
    plainBytes: fs.statSync(plain).size,
    diagBytes: fs.statSync(diag).size,
  }
}

// ---------------- AC-P01 冷启动到可输入 ----------------
async function runP01(win) {
  const t0 = creationTime
  await waitEditable(win)
  // 等到下一帧画完再算「可输入」
  await win.webContents.executeJavaScript(
    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))'
  )
  const end = Date.now()
  const showMs = showAt ? round(showAt - t0) : null
  const editableMs = round(end - t0)
  finish({
    creationTime: new Date(t0).toISOString(),
    showMs,
    editableMs,
    totalMs: round(Math.max(showMs || 0, editableMs)),
    note: '起点 process.getCreationTime()，终点为窗口已显示且编辑器可输入后再画两帧（主进程计时，±10ms）',
  })
}

// ---------------- AC-P02 打开 1MB 文件到渲染完成 ----------------
async function runP02(win) {
  await waitEditable(win)
  const run = js(win)
  const files = ensureBigSamples()
  await run(`
    window.__perfLoad = async (md, file, expectDiagrams) => {
      const t0 = performance.now()
      window.__test.loadDoc({ path: file, name: file.split(/[\\\\/]/).pop(), content: md })
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      const textMs = performance.now() - t0
      let diagramMs = null
      if (expectDiagrams) {
        const end = t0 + 20000
        while (performance.now() < end) {
          if (document.querySelectorAll('.mermaid-view svg').length >= expectDiagrams) {
            diagramMs = performance.now() - t0
            break
          }
          await new Promise(r => setTimeout(r, 20))
        }
      }
      return { textMs, diagramMs }
    }
    true`)
  const measure = async (file, reps) => {
    const md = fs.readFileSync(file, 'utf8')
    await run(`window.__perfMd = ${JSON.stringify(md)}; true`)
    const text = []
    const diagrams = []
    for (let i = 0; i < reps; i++) {
      await run(`window.__test.loadDoc({}); await new Promise(r => setTimeout(r, 200)); true`)
      // 只在第一次载入时量流程图出现的时间（这时流程图组件还没载入）
      const r = await run(
        `return await window.__perfLoad(window.__perfMd, ${JSON.stringify(file)}, ${i === 0 ? 2 : 0})`
      )
      text.push(round(r.textMs))
      if (r.diagramMs != null) diagrams.push(round(r.diagramMs))
    }
    const last = await run(`return { chars: window.__editor.state.doc.textContent.length, nodes: window.__editor.state.doc.nodeSize, markdownChars: window.__editor.storage.markdown.getMarkdown().length, diagrams: document.querySelectorAll('.mermaid-view svg').length }`)
    return { file, bytes: fs.statSync(file).size, ms: text, stats: stats(text), diagramMs: diagrams, ...last }
  }
  const plain = await measure(files.plain, 5)
  const diag = await measure(files.diag, 5)
  finish({
    plain,
    diag,
    note: 'loadDoc → 两次 requestAnimationFrame；每个样本 5 次取中位数。含流程图的第一次另外记录到图出现的时间（流程图组件按需载入），不计入 AC-P02 的正文渲染时间',
  })
}

// ---------------- AC-P03 1MB 文件中的输入延迟（真实按键） ----------------
async function runP03(win) {
  win.setAlwaysOnTop(true)
  win.show()
  win.focus()
  win.webContents.focus()
  const run = js(win)
  await waitEditable(win)
  await wait(600)
  const files = ensureBigSamples()

  const instrument = async () => {
    await run(`
      window.__perfKeys = { lat: [], slow: [], pending: null, scheduled: 0, frames: 0, t0: 0 }
      window.addEventListener('keydown', (e) => {
        if (!e.isTrusted) return
        if (window.__perfKeys.pending == null) window.__perfKeys.pending = performance.now()
      }, true)
      window.addEventListener('keyup', (e) => {
        if (!e.isTrusted) return
        const p = window.__perfKeys.pending
        if (p == null) return
        window.__perfKeys.pending = null
        window.__perfKeys.scheduled++
        requestAnimationFrame(() => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => {
            window.__perfKeys.scheduled--
            window.__perfKeys.lat.push(performance.now() - p)
            window.__perfKeys.total++
          }
          ch.port2.postMessage(0)
        })
      }, true)
      try {
        window.__perfKeys.obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__perfKeys.slow.push(Math.round(e.duration))
        })
        window.__perfKeys.obs.observe({ type: 'event', durationThreshold: 16 })
      } catch (e) {}
      window.__perfKeys.t0 = performance.now()
      ;(function tick() {
        window.__perfKeys.frames++
        requestAnimationFrame(tick)
      })()
      true`)
  }

  const sendKey = (ch) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
  }

  const typeKeys = async (count, gap) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz'
    for (let i = 0; i < count; i++) {
      sendKey(chars[i % chars.length])
      await wait(gap)
    }
    await wait(600)
  }

  const placeCursor = (where) =>
    run(`
      const e = window.__editor
      let pos = null
      const want = ${where === 'code' ? `'codeBlock'` : `'paragraph'`}
      e.state.doc.descendants((n, p) => {
        if (pos != null) return false
        if (!n.isText || n.text.length < 20 || p < e.state.doc.content.size * 0.3) return
        const parent = e.state.doc.resolve(p).parent
        if (parent.type.name === want) pos = p + 3
        return false
      })
      e.commands.setTextSelection(pos || 1)
      e.commands.focus()
      const parent = pos ? e.state.doc.resolve(pos).parent.type.name : null
      return { pos: pos || 1, parent, focused: document.activeElement === e.view.dom }
    `)

  const loadFile = async (file, diagrams) => {
    const md = fs.readFileSync(file, 'utf8')
    await run(`window.__perfMd = ${JSON.stringify(md)}; true`)
    await run(
      `window.__test.loadDoc({ path: ${JSON.stringify(file)}, name: ${JSON.stringify(path.basename(file))}, content: window.__perfMd }); await new Promise(r => setTimeout(r, 800)); true`
    )
    if (diagrams) {
      for (let i = 0; i < 800; i++) {
        if ((await run(`return document.querySelectorAll('.mermaid-view svg').length`)) >= 2) break
        await wait(25)
      }
    }
  }

  // 一次一键、间隔 gap：间隔够大时测的是单次按键的响应，间隔很小时测的是输入队列会不会堆积
  const roundOf = async ({ file, diagrams, where, count = 30, gap = 300 }) => {
    await loadFile(file, diagrams)
    const cursor = await placeCursor(where)
    win.focus()
    win.webContents.focus()
    await wait(300)
    await instrument()
    await typeKeys(count, gap)
    const r = await run(`return {
      lat: window.__perfKeys.lat,
      slow: window.__perfKeys.slow,
      frames: window.__perfKeys.frames,
      elapsed: performance.now() - window.__perfKeys.t0,
      scheduled: window.__perfKeys.scheduled,
      focused: document.activeElement === window.__editor.view.dom,
      chars: window.__editor.state.doc.textContent.length,
      dirty: window.__test.state.dirty,
    }`)
    return {
      file: path.basename(file),
      bytes: fs.statSync(file).size,
      diagrams,
      where,
      gap,
      cursor,
      keys: r.lat.length,
      framesPerSecond: Math.round((r.frames / r.elapsed) * 1000),
      pending: r.scheduled,
      dirty: r.dirty,
      chars: r.chars,
      slowOver16ms: r.slow.slice(0, 20),
      stats: stats(r.lat),
    }
  }

  // 1) 正文里输入（最常见）；2) 代码块里输入（会触发代码高亮整篇重算）
  const plainPara = await roundOf({ file: files.plain, diagrams: false, where: 'para' })
  const plainCode = await roundOf({ file: files.plain, diagrams: false, where: 'code' })
  const diagPara = await roundOf({ file: files.diag, diagrams: true, where: 'para' })
  const diagCode = await roundOf({ file: files.diag, diagrams: true, where: 'code' })
  // 3) 快速连打：看输入队列会不会越积越多（帧率下降、未处理事件变多）
  const fastBurst = await roundOf({ file: files.plain, diagrams: false, where: 'para', count: 20, gap: 80 })
  // 4) 不同大小的混合文档：50ms 的目标从多大开始达不到
  const sizeSweep = []
  for (const kb of [100, 300, 600]) {
    const f = path.join(OUT, 'samples', `perf-${kb}kb.md`)
    if (!fs.existsSync(f)) fs.writeFileSync(f, makeBigMd(kb * 1024, 0), 'utf8')
    const r = await roundOf({ file: f, diagrams: false, where: 'para', count: 10, gap: 300 })
    sizeSweep.push({ kb, bytes: r.bytes, chars: r.chars, stats: r.stats })
  }

  finish({
    plainPara,
    plainCode,
    diagPara,
    diagCode,
    fastBurst,
    sizeSweep,
    note:
      '真实按键（keyDown→char→keyUp）。单次按键 = keydown 到 keyup 之后下一帧（间隔 300ms，避免输入排队）；' +
      '快速连打 = 间隔 80ms，用帧率和未处理事件数看队列是否堆积。「正文」= 光标在普通段落，「代码块」= 光标在代码块里；' +
      'sizeSweep 是同样混合结构的 100/300/600KB 文档，正文输入',
  })
}

// ------------------------------ AC-P04 空文档内存 ------------------------------
function privateWorkingSet(pids) {
  if (process.platform !== 'win32' || !pids.length) return null
  try {
    const list = pids.join(',')
    // Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate 的单位是字节（已用资源管理器核对）
    const cmd =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
      `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { @(${list}) -contains $_.IDProcess } | ` +
      'Select-Object IDProcess,Name,WorkingSetPrivate | ConvertTo-Json -Compress'
    const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 20000,
    }).trim()
    if (!out) return null
    const rows = [].concat(JSON.parse(out))
    return rows.map((r) => ({ pid: r.IDProcess, name: r.Name, privateWorkingSetBytes: r.WorkingSetPrivate }))
  } catch (e) {
    return { error: String(e.message || e) }
  }
}

// Get-Process 的 WorkingSet64 / PrivateMemorySize64，用来核对 Electron 自己报的两个口径
function processWorkingSet(pids) {
  if (process.platform !== 'win32' || !pids.length) return null
  try {
    const cmd =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
      `Get-Process -Id @(${pids.join(',')}) -ErrorAction SilentlyContinue | ` +
      'Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress'
    const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 20000,
    }).trim()
    if (!out) return null
    return [].concat(JSON.parse(out)).map((r) => ({ pid: r.Id, workingSetBytes: r.WorkingSet64, privateBytes: r.PrivateMemorySize64 }))
  } catch (e) {
    return { error: String(e.message || e) }
  }
}

async function runP04(win) {
  await waitEditable(win)
  await wait(10000) // 空文档等 10 秒
  const metrics = app.getAppMetrics()
  const rows = metrics.map((m) => ({
    pid: m.pid,
    type: m.type,
    name: m.name,
    workingSetKB: m.memory?.workingSetSize ?? null,
    privateKB: m.memory?.privateBytes ?? null,
    cpu: m.cpu?.percentCPUUsage ?? null,
  }))
  const workMB = rows.reduce((s, r) => s + (r.workingSetKB || 0), 0) / 1024
  const privMB = rows.reduce((s, r) => s + (r.privateKB || 0), 0) / 1024
  const pids = rows.map((r) => r.pid)
  const cim = privateWorkingSet(pids)
  const cimBytes = Array.isArray(cim) ? cim.reduce((s, r) => s + (r.privateWorkingSetBytes || 0), 0) : null
  const ps = processWorkingSet(pids)
  const psWorkBytes = Array.isArray(ps) ? ps.reduce((s, r) => s + (r.workingSetBytes || 0), 0) : null
  const psPrivBytes = Array.isArray(ps) ? ps.reduce((s, r) => s + (r.privateBytes || 0), 0) : null
  const page = await win.webContents.executeJavaScript(
    '({ heap: performance.memory ? performance.memory.usedJSHeapSize : null, docNodes: window.__editor.state.doc.nodeSize })'
  )
  finish({
    processes: rows,
    workingSetMB: round(workMB),
    privateBytesMB: round(privMB),
    privateWorkingSetMB: cimBytes == null ? null : round(cimBytes / 1048576),
    privateWorkingSetRaw: cim,
    getProcess: ps,
    getProcessWorkingSetMB: psWorkBytes == null ? null : round(psWorkBytes / 1048576),
    getProcessPrivateMB: psPrivBytes == null ? null : round(psPrivBytes / 1048576),
    page,
    note:
      '任务管理器「内存（专用工作集）」口径 = Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate 合计（字节→MB）；' +
      '同时记录 Get-Process 的 WorkingSet64（含共享 DLL，会偏大）与 PrivateMemorySize64（提交大小），以及 Electron app.getAppMetrics 的 workingSetSize / privateBytes',
  })
}

// ---------------- AC-P05 连续使用 30 分钟 ----------------
async function runP05(win) {
  const run = js(win)
  await waitEditable(win)
  const dur = Math.max(1, MINUTES) * 60 * 1000
  const work = path.join(OUT, 'p05-samples')
  fs.rmSync(work, { recursive: true, force: true })
  fs.cpSync(path.join(__dirname, '..', 'samples'), work, { recursive: true })
  const P = (...a) => path.join(work, ...a)
  const files = [P('示例.md'), P('github', 'README.md'), P('笔记', '流程与换行.md'), P('连载', '01-开篇.md'), P('索引', '01-甲.md')].filter((f) => fs.existsSync(f))

  const menuClick = (acc) => {
    const found = []
    const walk = (menu) => menu.items.forEach((i) => { if (i.accelerator === acc) found.push(i); if (i.submenu) walk(i.submenu) })
    walk(Menu.getApplicationMenu())
    if (!found.length) throw new Error('菜单中没有登记快捷键 ' + acc)
    found[0].click(undefined, win, win.webContents)
  }

  const minuteLog = []
  const actions = { load: 0, edit: 0, undo: 0, source: 0, read: 0, save: 0, folder: 0, link: 0 }
  const start = Date.now()
  let lastMinute = -1
  let iter = 0
  let lastError = null

  const sampleMemory = async () => {
    const metrics = app.getAppMetrics()
    const workMB = metrics.reduce((s, m) => s + (m.memory?.workingSetSize || 0), 0) / 1024
    const privMB = metrics.reduce((s, m) => s + (m.memory?.privateBytes || 0), 0) / 1024
    let heap = null
    try {
      heap = await win.webContents.executeJavaScript('performance.memory ? performance.memory.usedJSHeapSize : null')
    } catch (e) {}
    return { workingSetMB: round(workMB), privateBytesMB: round(privMB), jsHeapMB: heap == null ? null : round(heap / 1048576), processes: metrics.length }
  }

  try {
    while (Date.now() - start < dur && !crashes.length) {
      iter++
      const f = files[iter % files.length]
      // 打开
      await run(`const d = await window.api.readFile(${JSON.stringify(f)}); window.__test.loadDoc(d); await new Promise(r => setTimeout(r, 300)); true`)
      actions.load++
      // 编辑、撤销
      await run(`window.__editor.chain().focus('end').insertContent(' 性能巡检 ' + ${iter}).run(); await new Promise(r => setTimeout(r, 450)); true`)
      actions.edit++
      menuClick('CmdOrCtrl+Z')
      await wait(250)
      actions.undo++
      // 源码模式来回
      menuClick('CmdOrCtrl+/')
      await wait(400)
      menuClick('CmdOrCtrl+/')
      await wait(300)
      actions.source++
      // 阅读模式来回
      menuClick('CmdOrCtrl+R')
      await wait(400)
      menuClick('CmdOrCtrl+R')
      await wait(300)
      actions.read++
      // 保存到副本
      menuClick('CmdOrCtrl+S')
      await wait(400)
      actions.save++
      // 篇目跳转（带翻页动效）
      if (iter % 3 === 0) {
        await run(`await window.__test.openFolder(${JSON.stringify(P('连载'))}); await new Promise(r => setTimeout(r, 400)); true`)
        await run(`await window.__test.goSide('next'); true`)
        await wait(1700)
        actions.folder++
      }
      // 链接跳转（带链接动效）
      if (iter % 4 === 0) {
        await run(`const d = await window.api.readFile(${JSON.stringify(P('连载', '01-开篇.md'))}); window.__test.loadDoc(d); await new Promise(r => setTimeout(r, 400)); await window.__test.handleLink('02-第二章.md'); await new Promise(r => setTimeout(r, 3000)); true`)
        actions.link++
      }
      const minute = Math.floor((Date.now() - start) / 60000)
      if (minute !== lastMinute) {
        lastMinute = minute
        const mem = await sampleMemory()
        minuteLog.push({ minute, iterations: iter, ...mem })
      }
      // 留一点空闲，不让机器一直满载
      await wait(300)
    }
  } catch (e) {
    lastError = String((e && e.stack) || e)
  }

  const finalMem = await sampleMemory().catch(() => null)
  const peek = (key) => {
    const vals = minuteLog.map((m) => m[key]).filter((v) => v != null)
    return vals.length ? { first: vals[0], last: vals[vals.length - 1], max: Math.max(...vals) } : null
  }
  finish({
    minutes: MINUTES,
    elapsedMinutes: round((Date.now() - start) / 60000, 2),
    iterations: iter,
    actions,
    errors: consoleErrors.slice(),
    crashes,
    lastError,
    minuteLog,
    finalMem,
    trend: { workingSetMB: peek('workingSetMB'), privateBytesMB: peek('privateBytesMB'), jsHeapMB: peek('jsHeapMB') },
    note: '每轮：打开样本副本 → 编辑 → 撤销 → 源码模式来回 → 阅读模式来回 → 保存；每 3 轮篇目翻页，每 4 轮链接跳转；每分钟记一次内存',
  })
}

async function main(win) {
  await wait(600)
  if (MODE === 'p01') return runP01(win)
  if (MODE === 'p02') return runP02(win)
  if (MODE === 'p03') return runP03(win)
  if (MODE === 'p04') return runP04(win)
  if (MODE === 'p05') return runP05(win)
  finish({ error: '未知模式：' + MODE })
}
