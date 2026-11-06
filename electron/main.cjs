const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const { pathToFileURL } = require('node:url')

const DEV_URL = process.env.VITE_DEV_SERVER_URL
const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

// 每个窗口的文档状态：{ dirty, path }
const winState = new Map()

// Windows 11 22H2（build 22621）及以上支持 Mica 半透明材质
const SUPPORTS_MICA = process.platform === 'win32' && Number(require('node:os').release().split('.')[2] || 0) >= 22621
const TITLEBAR_HEIGHT = 52
const DEV_ICON = [path.join(__dirname, '..', 'build', 'icon.png')].find((p) => !app.isPackaged && fsSync.existsSync(p))
const overlayColors = (dark) => ({
  color: SUPPORTS_MICA ? '#00000000' : dark ? '#1c1c1e' : '#f5f5f7',
  symbolColor: dark ? '#f5f5f7' : '#1d1d1f',
  height: TITLEBAR_HEIGHT,
})
// 窗口关闭时，已经确认过可以关闭
const allowClose = new Set()

// 改名为 Paperwind（2026-11-06）：数据目录从 %APPDATA%\markdown-app 换成 %APPDATA%\Paperwind。
// 第一次以新名字启动时，把草稿、阅读记录和界面偏好搬过来，旧目录原样保留不删。
// 自测等脚本自己指定了数据目录时不搬（只在用的是默认目录时搬）。
// 注意：Electron 在运行本文件之前就会建好（空的）数据目录，所以不能用「目录在不在」判断是不是第一次，
// 改用一个标记文件；每一项只在新目录里还没有时才复制，不覆盖新目录里已有的内容。
const MIGRATED_MARK = 'migrated-from-markdown-app'
function migrateUserData() {
  try {
    const appData = app.getPath('appData')
    const target = app.getPath('userData')
    const legacy = path.join(appData, 'markdown-app')
    const isDefault = target.toLowerCase() === path.join(appData, app.getName()).toLowerCase()
    if (!isDefault || target.toLowerCase() === legacy.toLowerCase()) return
    const mark = path.join(target, MIGRATED_MARK)
    if (fsSync.existsSync(mark) || !fsSync.existsSync(legacy)) return
    fsSync.mkdirSync(target, { recursive: true })
    for (const item of ['drafts', 'reading.json', 'Local Storage']) {
      const from = path.join(legacy, item)
      const to = path.join(target, item)
      if (!fsSync.existsSync(from)) continue
      // 界面偏好（Local Storage）是一个数据库，不能和已有的混在一起：新目录里已经有了就不搬
      if (item === 'Local Storage' && fsSync.existsSync(to)) continue
      try {
        // force: false —— 新目录里已有的文件（例如改名后已经产生的草稿、阅读记录）保留，只补上缺的
        fsSync.cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
      } catch {}
    }
    fsSync.writeFileSync(mark, new Date().toISOString(), 'utf8')
  } catch {}
}
migrateUserData()

protocol.registerSchemesAsPrivileged([
  { scheme: 'localfile', privileges: { supportFetchAPI: true, stream: true, bypassCSP: true } },
])

function findFileArg(argv) {
  const f = argv.slice(1).find((a) => MD_EXT.test(a) && fsSync.existsSync(a))
  return f ? path.resolve(f) : null
}

async function readDoc(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  return { path: filePath, name: path.basename(filePath), content: content.replace(/^﻿/, '') }
}

function createWindow(filePath = null) {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 680,
    minHeight: 460,
    show: false,
    title: 'Paperwind',
    // 打包后任务栏用 exe 自带的图标；开发运行时用 build/icon.png（设计规范 §3.5b）
    ...(DEV_ICON ? { icon: DEV_ICON } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(nativeTheme.shouldUseDarkColors),
    ...(SUPPORTS_MICA
      ? { backgroundMaterial: 'mica', backgroundColor: '#00000000' }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7' }),
    webPreferences: {
      additionalArguments: [SUPPORTS_MICA ? '--md-mica=1' : '--md-mica=0'],
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  winState.set(win.id, { dirty: false, path: filePath })

  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  win.once('ready-to-show', () => win.show())

  win.webContents.on('did-finish-load', async () => {
    if (filePath) {
      try {
        win.webContents.send('open-doc', await readDoc(filePath))
      } catch (e) {
        dialog.showErrorBox('打开失败', String(e.message || e))
      }
    }
  })

  // 链接一律用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:|^mailto:/.test(url)) shell.openExternal(url)
    }
  })

  win.webContents.on('context-menu', (_e, params) => showContextMenu(win, params))

  win.on('close', async (e) => {
    const st = winState.get(win.id)
    if (allowClose.has(win.id) || !st || !st.dirty) return
    e.preventDefault()
    const choice = await askSave(win)
    if (choice === 'cancel') return
    if (choice === 'save') {
      win.webContents.send('menu', 'saveThenClose')
      return
    }
    allowClose.add(win.id)
    win.close()
  })
  win.on('closed', () => {
    winState.delete(win.id)
    allowClose.delete(win.id)
  })
  return win
}

async function askSave(win) {
  const st = winState.get(win.id) || {}
  const name = st.path ? path.basename(st.path) : '未命名.md'
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'Paperwind',
    message: `是否保存对“${name}”的修改？`,
    detail: '如果不保存，修改将会丢失。',
  })
  return ['save', 'discard', 'cancel'][response]
}

// 在合适的窗口里打开文件：已打开过该文件则聚焦；当前是空白窗口则复用；否则新开窗口
async function openPath(filePath, preferWin = null) {
  for (const w of BrowserWindow.getAllWindows()) {
    const st = winState.get(w.id)
    if (st && st.path && path.resolve(st.path) === path.resolve(filePath)) {
      if (w.isMinimized()) w.restore()
      w.focus()
      return
    }
  }
  const target = preferWin || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const st = target && winState.get(target.id)
  if (target && st && !st.dirty && !st.path) {
    target.webContents.send('open-doc', await readDoc(filePath))
    target.focus()
  } else {
    createWindow(filePath)
  }
}

function showContextMenu(win, params) {
  const wc = win.webContents
  const cmd = (c) => () => wc.send('menu', c)
  const f = params.editFlags
  const items = []
  if (params.linkURL) {
    items.push(
      { label: '打开链接', click: () => /^https?:|^mailto:/.test(params.linkURL) && shell.openExternal(params.linkURL) },
      { label: '编辑链接…', click: cmd('editLink'), enabled: params.isEditable },
      { label: '移除链接', click: cmd('unlink'), enabled: params.isEditable },
      { type: 'separator' }
    )
  }
  items.push(
    { label: '剪切', role: 'cut', enabled: f.canCut },
    { label: '复制', role: 'copy', enabled: f.canCopy },
    { label: '粘贴', role: 'paste', enabled: f.canPaste },
    { label: '粘贴为纯文本', role: 'pasteAndMatchStyle', enabled: f.canPaste },
    { label: '全选', role: 'selectAll' }
  )
  if (params.isEditable) {
    items.push(
      { type: 'separator' },
      { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
      { label: '重做', accelerator: 'CmdOrCtrl+Y', click: cmd('redo') },
      { type: 'separator' },
      { label: '清除格式', accelerator: 'CmdOrCtrl+Shift+0', click: cmd('clearFormat') }
    )
  }
  Menu.buildFromTemplate(items).popup({ window: win })
}

// 菜单命令发给触发它的窗口（没有时退回当前焦点窗口）
function send(cmd, win) {
  const w = win || BrowserWindow.getFocusedWindow()
  if (w && !w.isDestroyed()) w.webContents.send('menu', cmd)
}

function buildMenu() {
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: (_m, w) => send('new', w) },
        { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: (_m, w) => send('open', w) },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: (_m, w) => send('openFolder', w) },
        { type: 'separator' },
        { label: '上一篇', accelerator: 'CmdOrCtrl+[', click: (_m, w) => send('prevDoc', w) },
        { label: '下一篇', accelerator: 'CmdOrCtrl+]', click: (_m, w) => send('nextDoc', w) },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: (_m, w) => send('save', w) },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: (_m, w) => send('saveAs', w) },
        { type: 'separator' },
        { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', role: 'close' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: (_m, w) => send('undo', w) },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', click: (_m, w) => send('redo', w) },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '粘贴为纯文本', role: 'pasteAndMatchStyle' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '侧栏', accelerator: 'CmdOrCtrl+\\', click: (_m, w) => send('outline', w) },
        { label: '源码模式', accelerator: 'CmdOrCtrl+/', click: (_m, w) => send('source', w) },
        { label: '切换编辑 / 阅读', accelerator: 'CmdOrCtrl+R', click: (_m, w) => send('read', w) },
        { label: '深色/浅色', accelerator: 'CmdOrCtrl+Shift+L', click: (_m, w) => send('theme', w) },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { label: '开发者工具', role: 'toggleDevTools', accelerator: 'F12' },
        { label: '重新加载', role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- IPC ----------
const winOf = (e) => BrowserWindow.fromWebContents(e.sender)

// ---------- 错误提示（设计规范 §4.10：错误必须用对话框） ----------
function friendlyError(e) {
  switch (e && e.code) {
    case 'EPERM':
    case 'EACCES':
    case 'EBUSY':
      return '文件是只读的、正在被其他程序使用，或者没有写入权限。可以用「另存为…」保存到其他位置。'
    case 'ENOENT':
      return '找不到这个文件，它可能已被移动或删除。'
    case 'ENOSPC':
      return '磁盘空间不足。'
    case 'EISDIR':
      return '这是一个文件夹，不是文件。'
    default:
      return String((e && e.message) || e)
  }
}
async function showError(win, message, e) {
  await dialog.showMessageBox(win, { type: 'error', buttons: ['好'], noLink: true, title: 'Paperwind', message, detail: friendlyError(e) })
}

// ---------- 草稿：写入磁盘，程序被强制结束也不丢 ----------
const crypto = require('node:crypto')
const draftDir = () => path.join(app.getPath('userData'), 'drafts')
const draftFile = (key) => path.join(draftDir(), crypto.createHash('sha1').update(key).digest('hex') + '.json')
// 「未命名」文档的草稿按窗口分开存：每个窗口一个会话编号（页面崩溃重新加载后不变），
// 避免两个未命名窗口互相把对方正在写的内容当成草稿，或把对方的草稿清掉（AC-F16、AC-F16b）。
// 程序整个退出后，没有窗口认领的未命名草稿成为「孤儿」，由下一个新开的未命名窗口提示恢复。
const UNTITLED = 'draft:untitled'
const sessions = new Map() // 窗口 id → 会话编号
const adopted = new Map() // 窗口 id → 它提示恢复的孤儿草稿（恢复或丢弃时删除）
const sessionKey = (w) => {
  if (!sessions.has(w.id)) sessions.set(w.id, crypto.randomUUID())
  return UNTITLED + ':' + sessions.get(w.id)
}
const realKey = (e, key) => {
  const w = winOf(e)
  return key === UNTITLED && w ? sessionKey(w) : key
}
app.on('browser-window-created', (_e, w) => {
  const id = w.id
  w.on('closed', () => {
    sessions.delete(id)
    adopted.delete(id)
  })
})
async function readDraft(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}
ipcMain.on('draft-save', (e, key, md) => {
  const k = realKey(e, key)
  const file = draftFile(k)
  try {
    fsSync.mkdirSync(draftDir(), { recursive: true })
    const tmp = file + '.tmp'
    fsSync.writeFileSync(tmp, JSON.stringify({ key: k, md, time: Date.now() }), 'utf8')
    fsSync.renameSync(tmp, file) // 先写临时文件再改名，避免写到一半损坏
  } catch {}
})
// 有路径的文件：草稿属于另一个仍打开着、有未保存修改的窗口时，不提示恢复，也不清掉
function draftOwnedByOther(e, key) {
  const me = winOf(e)
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === me || w.isDestroyed()) continue
    const st = winState.get(w.id)
    if (st && st.dirty && st.path && 'draft:' + st.path === key) return true
  }
  return false
}
ipcMain.handle('draft-load', async (e, key) => {
  if (key !== UNTITLED) {
    if (draftOwnedByOther(e, key)) return null
    const d = await readDraft(draftFile(key))
    return d && d.key === key ? d : null
  }
  // 未命名：先找本窗口自己的（页面崩溃后重新加载），再找没有窗口认领的孤儿草稿（取最新的一份）
  const w = winOf(e)
  if (!w) return null
  const own = await readDraft(draftFile(sessionKey(w)))
  if (own && own.md) return { ...own, key: UNTITLED }
  const live = new Set(BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed()).map((x) => sessionKey(x)))
  let best = null
  try {
    for (const f of await fs.readdir(draftDir())) {
      if (!f.endsWith('.json')) continue
      const d = await readDraft(path.join(draftDir(), f))
      if (!d || !d.md || !(d.key === UNTITLED || String(d.key).startsWith(UNTITLED + ':')) || live.has(d.key)) continue
      if (!best || d.time > best.time) best = d
    }
  } catch {}
  if (!best) return null
  adopted.set(w.id, best.key)
  return { ...best, key: UNTITLED }
})
ipcMain.on('draft-clear', (e, key) => {
  const w = winOf(e)
  if (key === UNTITLED && w) {
    fs.rm(draftFile(sessionKey(w)), { force: true }).catch(() => {})
    const orphan = adopted.get(w.id)
    if (orphan) {
      adopted.delete(w.id)
      fs.rm(draftFile(orphan), { force: true }).catch(() => {})
    }
    return
  }
  if (draftOwnedByOther(e, key)) return
  fs.rm(draftFile(key), { force: true }).catch(() => {})
})

ipcMain.handle('open-dialog', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(winOf(e), {
    title: '打开 Markdown 文件',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: '文本文件', extensions: ['txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  })
  if (canceled || !filePaths[0]) return null
  try {
    return await readDoc(filePaths[0])
  } catch (err) {
    await showError(winOf(e), `无法打开“${path.basename(filePaths[0])}”`, err)
    return { error: true }
  }
})

ipcMain.handle('read-file', async (e, filePath) => {
  try {
    return await readDoc(filePath)
  } catch (err) {
    await showError(winOf(e), `无法打开“${path.basename(filePath)}”`, err)
    return { error: true }
  }
})

ipcMain.handle('save-file', async (e, { path: filePath, content, saveAs, defaultName }) => {
  let target = filePath
  if (!target || saveAs) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(winOf(e), {
      title: '保存 Markdown 文件',
      defaultPath: filePath || defaultName || '未命名.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (canceled || !chosen) return null
    target = chosen
  }
  try {
    await fs.writeFile(target, content, 'utf8')
  } catch (err) {
    await showError(winOf(e), `无法保存“${path.basename(target)}”`, err)
    return { error: true }
  }
  return { path: target, name: path.basename(target) }
})

ipcMain.handle('pick-image', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(winOf(e), {
    title: '选择图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }],
  })
  return canceled ? null : filePaths[0]
})

ipcMain.handle('confirm-discard', async (e) => askSave(winOf(e)))

ipcMain.on('doc-state', (e, { dirty, path: p, title }) => {
  const w = winOf(e)
  if (!w) return
  winState.set(w.id, { dirty, path: p })
  w.setTitle(title)
  w.setDocumentEdited?.(dirty)
})

ipcMain.on('close-now', (e) => {
  const w = winOf(e)
  if (!w) return
  allowClose.add(w.id)
  w.close()
})

ipcMain.on('open-path', (e, p) => openPath(p, winOf(e)))
// =====================================================================
// 连续写作：文件夹篇目、链接跳转、阅读记录（PRD §3.6）
// =====================================================================
const NOTE_EXT = /\.(md|markdown|mdown|mkd)$/i
const collator = new Intl.Collator('zh-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' })
const sameFile = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// 子文件夹（设计规范 §4.11 v1.4）：跳过隐藏文件夹、工具文件夹和快捷方式链接；最多 10 层、5000 篇
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'bower_components', 'site-packages'])
const skipDir = (name) => name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())
const MAX_DEPTH = 10
const MAX_NOTES = 5000

// 返回 { children, count }：每一层先列文件夹、再列文章，两者各自按名称自然排序（PRD §3.6、设计规范 §4.11 v1.5）；
// 不含 Markdown 的文件夹不列出。篇数上限先留给这一层的文章，再往下扫子文件夹（文章很多时不会挤掉当前层的文章）
async function scanDir(dir, depth, budget) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { children: [], count: 0 }
  }
  entries.sort((a, b) => collator.compare(a.name, b.name))
  const dirs = []
  const files = []
  let count = 0
  for (const d of entries) {
    if (!(d.isFile() && NOTE_EXT.test(d.name))) continue
    if (budget.left <= 0) {
      budget.truncated = true
      break
    }
    files.push({ type: 'file', path: path.join(dir, d.name), name: d.name })
    count++
    budget.left--
  }
  for (const d of entries) {
    if (!(d.isDirectory() && !d.isSymbolicLink() && !skipDir(d.name) && depth < MAX_DEPTH)) continue
    if (budget.left <= 0) {
      budget.truncated = true
      break
    }
    const p = path.join(dir, d.name)
    const sub = await scanDir(p, depth + 1, budget)
    if (sub.count > 0) {
      dirs.push({ type: 'dir', path: p, name: d.name, children: sub.children })
      count += sub.count
    }
  }
  return { children: [...dirs, ...files], count }
}

ipcMain.handle('list-folder', async (_e, dir) => {
  try {
    await fs.access(dir)
    const budget = { left: MAX_NOTES, truncated: false }
    const { children, count } = await scanDir(dir, 0, budget)
    const files = children.filter((c) => c.type === 'file').map(({ path: p, name }) => ({ path: p, name }))
    const all = []
    const walk = (list) => list.forEach((c) => (c.type === 'file' ? all.push({ path: c.path, name: c.name }) : walk(c.children)))
    walk(children)
    return { dir, name: path.basename(dir) || dir, files, tree: children, all, count, truncated: budget.truncated }
  } catch (err) {
    return { dir, name: path.basename(dir), files: [], tree: [], all: [], count: 0, error: String(err.code || err) }
  }
})

// 每个窗口监视当前文件夹，文件增删改名时通知页面刷新篇目
const watchers = new Map()
ipcMain.on('watch-folder', (e, dir) => {
  const w = winOf(e)
  if (!w) return
  const old = watchers.get(w.id)
  if (old && old.dir === dir) return
  old?.watcher.close()
  watchers.delete(w.id)
  if (!dir) return
  try {
    let t
    // 监视所有层级（子文件夹 v1.4）：Markdown 文件或文件夹（无扩展名）变化时刷新；隐藏 / 工具文件夹里的变化忽略
    const watcher = fsSync.watch(dir, { persistent: false, recursive: true }, (_type, name) => {
      if (name) {
        const parts = String(name).split(/[\\/]/)
        if (parts.slice(0, -1).some(skipDir) || skipDir(parts[parts.length - 1])) return
        const last = parts[parts.length - 1]
        if (/\.[a-z]{1,5}$/i.test(last) && !NOTE_EXT.test(last)) return // 其他类型的文件（.txt、.png……）
      }
      clearTimeout(t)
      t = setTimeout(() => !w.isDestroyed() && w.webContents.send('folder-changed', dir), 250)
    })
    watcher.on('error', () => {})
    watchers.set(w.id, { dir, watcher })
  } catch {}
})
app.on('browser-window-created', (_e, w) => {
  w.on('closed', () => {
    watchers.get(w.id)?.watcher.close()
    watchers.delete(w.id)
  })
})

ipcMain.handle('pick-folder', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(winOf(e), { title: '打开文件夹', properties: ['openDirectory'] })
  return canceled ? null : filePaths[0]
})

// 翻页索引：从其他位置选一篇 Markdown 作为上一篇 / 下一篇（设计规范 §4.13b）
ipcMain.handle('pick-markdown', async (e, title, defaultPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(winOf(e), {
    title: title || '选择文章',
    defaultPath: defaultPath || undefined,
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }],
  })
  const p = canceled ? null : filePaths[0]
  return p && NOTE_EXT.test(p) ? p : null
})

ipcMain.handle('stat-path', async (_e, p) => {
  try {
    const s = await fs.stat(p)
    return { exists: true, isDir: s.isDirectory() }
  } catch {
    return { exists: false, isDir: false }
  }
})

// 解析文中的本地链接：Markdown → 在程序内打开；其他文件 → 在资源管理器中显示（绝不运行）；不存在 → 提示
ipcMain.handle('resolve-link', async (e, fromPath, href) => {
  const w = winOf(e)
  let raw = String(href || '').trim()
  const hashAt = raw.indexOf('#')
  let hash = ''
  if (hashAt >= 0) {
    hash = raw.slice(hashAt + 1)
    raw = raw.slice(0, hashAt)
  }
  try {
    raw = decodeURIComponent(raw)
  } catch {}
  try {
    hash = decodeURIComponent(hash)
  } catch {}
  raw = raw.replace(/^file:\/\/\/?/i, '')
  const isAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')
  const base = fromPath ? path.dirname(fromPath) : null
  const name = path.basename(raw) || raw
  if (!isAbs && !base) {
    await showError(w, `找不到“${name}”`, { code: 'NOLINKBASE', message: '当前文档还没有保存，无法确定链接的位置。请先保存文档。' })
    return { kind: 'missing' }
  }
  const target = isAbs ? path.resolve(raw) : path.resolve(base, raw)
  let st = null
  try {
    st = await fs.stat(target)
  } catch {}
  if (!st) {
    await dialog.showMessageBox(w, { type: 'warning', buttons: ['好'], noLink: true, title: 'Paperwind', message: `找不到“${name}”`, detail: '它可能已被移动、重命名或删除。' })
    return { kind: 'missing' }
  }
  if (st.isFile() && NOTE_EXT.test(target)) return { kind: 'md', path: target, hash }
  shell.showItemInFolder(target)
  return { kind: 'other', path: target }
})

// 翻页索引双向对应（设计规范 §4.13b）：另一篇正在别的窗口打开时，交给那个窗口改它编辑器里的内容，不直接写文件
ipcMain.handle('index-elsewhere', (e, p, payload) => {
  const me = winOf(e)
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === me) continue
    const st = winState.get(w.id)
    if (st && sameFile(st.path, p)) {
      w.webContents.send('apply-index', payload)
      return true
    }
  }
  return false
})

// 目标已在其他窗口打开时，聚焦那个窗口
ipcMain.handle('focus-if-open', (e, p) => {
  const me = winOf(e)
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === me) continue
    const st = winState.get(w.id)
    if (st && sameFile(st.path, p)) {
      if (w.isMinimized()) w.restore()
      w.focus()
      return true
    }
  }
  return false
})

// 翻页动效：截取正文区域的像素（设计规范 §6.6）。rect 为页面 CSS 像素，按页面缩放换算成窗口坐标
ipcMain.handle('capture-rect', async (e, r) => {
  try {
    const z = e.sender.getZoomFactor() || 1
    const rect = { x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.round(r.width * z), height: Math.round(r.height * z) }
    if (rect.width < 2 || rect.height < 2) return null
    const img = await e.sender.capturePage(rect)
    const sf = Math.max(1, ...(img.getScaleFactors?.() || [1]))
    const { width, height } = img.getSize(sf)
    if (!width || !height) return null
    return { width, height, data: img.toBitmap({ scaleFactor: sf }) } // BGRA
  } catch {
    return null
  }
})

// 标题栏「打开」按钮的右键菜单
ipcMain.on('open-button-menu', (e) => {
  const w = winOf(e)
  Menu.buildFromTemplate([
    { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: () => send('open', w) },
    { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('openFolder', w) },
  ]).popup({ window: w })
})

// 阅读记录：只存于程序自己的数据目录，不在用户文件夹写任何文件
const memory = { data: null, timer: null }
const memFile = () => path.join(app.getPath('userData'), 'reading.json')
const memKey = (p) => path.resolve(p).toLowerCase()
function memLoad() {
  if (memory.data) return memory.data
  try {
    memory.data = JSON.parse(fsSync.readFileSync(memFile(), 'utf8'))
  } catch {
    memory.data = {}
  }
  memory.data.folders ||= {}
  memory.data.files ||= {}
  if (!memory.data.roots) {
    // 「打开过的文件夹」（篇目树的根）。旧记录里没有这一项：记下的那一篇在子文件夹里的，说明它是打开过的根
    memory.data.roots = {}
    for (const [k, v] of Object.entries(memory.data.folders)) {
      if (v?.file && memKey(path.dirname(v.file)) !== k) memory.data.roots[k] = { t: v.t || 0 }
    }
  }
  return memory.data
}
// 单独打开一篇时，找它所在的、最近打开过的那个文件夹，用作篇目树的根（§4.11）
function rootFor(p) {
  const k = memKey(p)
  let best = null
  for (const [r, v] of Object.entries(memLoad().roots)) {
    if (!k.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) continue
    if (!fsSync.existsSync(r)) continue
    if (!best || (v.t || 0) > best.t) best = { dir: r, t: v.t || 0 }
  }
  if (!best) return null
  try {
    return fsSync.realpathSync.native(best.dir) // 记录的键是小写的，取回磁盘上真实的大小写（写进链接的路径保持原样）
  } catch {
    return null
  }
}
function memTrim(obj, max) {
  const keys = Object.keys(obj)
  if (keys.length <= max) return
  keys.sort((a, b) => (obj[b].t || 0) - (obj[a].t || 0)).slice(max).forEach((k) => delete obj[k])
}
function memSaveSoon() {
  clearTimeout(memory.timer)
  memory.timer = setTimeout(memFlush, 400)
}
function memFlush() {
  clearTimeout(memory.timer)
  if (!memory.data) return
  memTrim(memory.data.folders, 200)
  memTrim(memory.data.files, 2000)
  memTrim(memory.data.roots || {}, 50)
  try {
    const tmp = memFile() + '.tmp'
    fsSync.writeFileSync(tmp, JSON.stringify(memory.data), 'utf8')
    fsSync.renameSync(tmp, memFile())
  } catch {}
}
app.on('before-quit', memFlush)
ipcMain.handle('memory-root-for', (_e, p) => (p ? rootFor(p) : null))
ipcMain.handle('memory-get', (_e, kind, p) => (p ? memLoad()[kind]?.[memKey(p)] || null : null))
ipcMain.on('memory-set', (_e, kind, p, value) => {
  if (!p || !['folders', 'files', 'roots'].includes(kind)) return
  const d = memLoad()
  d[kind][memKey(p)] = { ...value, t: Date.now() }
  memSaveSoon()
})

ipcMain.on('open-external', (_e, url) => {
  if (/^https?:|^mailto:/.test(url)) shell.openExternal(url)
})
ipcMain.on('set-theme', (_e, theme) => {
  nativeTheme.themeSource = theme || 'system'
  const colors = overlayColors(nativeTheme.shouldUseDarkColors)
  for (const w of BrowserWindow.getAllWindows()) w.setTitleBarOverlay?.(colors)
})

// ---------- 启动 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const f = findFileArg(argv)
    if (f) openPath(f)
    else {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) {
        if (w.isMinimized()) w.restore()
        w.focus()
      } else createWindow()
    }
  })

  app.whenReady().then(() => {
    // 让编辑器能显示本地图片：localfile://file?path=<绝对路径>
    protocol.handle('localfile', (req) => {
      const p = new URL(req.url).searchParams.get('path') || ''
      if (!IMG_EXT.test(p)) return new Response('forbidden', { status: 403 })
      // 图片不存在时返回 404，而不是在主进程中抛出错误
      return net.fetch(pathToFileURL(p).toString()).catch(() => new Response('not found', { status: 404 }))
    })
    buildMenu()
    nativeTheme.on('updated', () => {
      const colors = overlayColors(nativeTheme.shouldUseDarkColors)
      for (const w of BrowserWindow.getAllWindows()) w.setTitleBarOverlay?.(colors)
    })
    createWindow(findFileArg(process.argv))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
