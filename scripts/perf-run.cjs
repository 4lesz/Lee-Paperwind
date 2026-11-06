// 性能验收汇总：node scripts/perf-run.cjs [--modes=p01,p02,p04] [--repeat=5] [--minutes=30]
// 逐项启动 electron scripts/perf.cjs（独立进程、独立数据目录），汇总到 test-output/perf/summary.json。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : dflt
}
const MODES = opt('modes', 'p01,p02,p04').split(',').map((s) => s.trim()).filter(Boolean)
const REPEAT = Number(opt('repeat', '5'))
const MINUTES = Number(opt('minutes', '30'))
const OUT = path.resolve(root, opt('out', path.join('test-output', 'perf')))
const electron = require('electron')

fs.mkdirSync(OUT, { recursive: true })

const round = (n, d = 1) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d)
const stats = (arr) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
  return { n: s.length, min: round(s[0]), median: round(q(0.5)), p95: round(q(0.95)), max: round(s[s.length - 1]) }
}

// dist 是否比源码旧（旧了就不是「打包后的同一份代码」）
function distStale() {
  const newest = (dir, out = { t: 0, f: null }) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) newest(p, out)
      else if (st.mtimeMs > out.t) { out.t = st.mtimeMs; out.f = p }
    }
    return out
  }
  try {
    const src = Math.max(
      ...[path.join(root, 'src'), path.join(root, 'electron')].map((d) => newest(d).t),
      fs.statSync(path.join(root, 'index.html')).mtimeMs
    )
    const dist = newest(path.join(root, 'dist')).t
    return src > dist ? { stale: true, newestSource: newest(path.join(root, 'src')).f } : { stale: false }
  } catch (e) {
    return { stale: true, error: String(e.message || e) }
  }
}

function runMode(mode, outDir, extraArgs = []) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const started = Date.now()
  console.log(`\n▶ ${mode.toUpperCase()} 启动（${path.basename(outDir)}）…`)
  const res = spawnSync(electron, [path.join(root, 'scripts', 'perf.cjs'), `--mode=${mode}`, `--out=${outDir}`, ...extraArgs], {
    cwd: root,
    stdio: 'inherit',
    timeout: mode === 'p05' ? (MINUTES + 20) * 60 * 1000 : 30 * 60 * 1000,
  })
  const elapsed = round((Date.now() - started) / 1000)
  const file = path.join(outDir, mode + '.json')
  if (!fs.existsSync(file)) {
    return { mode, ok: false, elapsedSeconds: elapsed, error: `没有生成结果（退出码 ${res.status}${res.error ? '，' + res.error.message : ''}）` }
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { mode, ok: true, elapsedSeconds: elapsed, data }
}

const summary = {
  startedAt: new Date().toISOString(),
  modes: MODES,
  dist: distStale(),
  results: {},
  verdicts: [],
}

const verdict = (id, desc, pass, detail) => summary.verdicts.push({ id, desc, pass: !!pass, detail })

for (const mode of MODES) {
  if (mode === 'p01') {
    const runs = []
    for (let i = 1; i <= REPEAT; i++) {
      const r = runMode('p01', path.join(OUT, 'p01-run' + i))
      if (r.ok && r.data && !r.data.error) runs.push(r.data)
      else console.log(`  第 ${i} 次失败：${r.error || r.data?.error}`)
    }
    const totals = runs.map((r) => r.totalMs)
    const st = stats(totals)
    summary.results.p01 = {
      runs: runs.map((r, i) => ({ run: i + 1, totalMs: r.totalMs, showMs: r.showMs, editableMs: r.editableMs, consoleErrors: r.consoleErrors })),
      stats: st,
      first: runs[0] || null,
    }
    verdict(
      'AC-P01',
      `冷启动到可输入 ≤ 2 秒（5 次中位数）`,
      st && st.median <= 2000,
      st ? { median: st.median, first: runs[0]?.totalMs, min: st.min, max: st.max } : '没有结果'
    )
    if (st) console.log(`  P01 中位数 ${st.median}ms（第一次 ${runs[0].totalMs}ms，最小 ${st.min}ms，最大 ${st.max}ms）`)
  } else if (mode === 'p02') {
    const r = runMode('p02', path.join(OUT, 'p02'))
    summary.results.p02 = r.data || { error: r.error }
    const d = r.data
    const ok = d && !d.error && d.plain?.stats?.median <= 1500 && d.diag?.stats?.median <= 1500
    verdict(
      'AC-P02',
      '打开 1MB 文件到渲染完成 ≤ 1.5 秒（不含 / 含流程图）',
      ok,
      d ? { plain: d.plain?.stats, diag: d.diag?.stats, diagramMs: d.diag?.diagramMs } : r.error
    )
    if (d && d.plain) console.log(`  P02 不含流程图中位数 ${d.plain.stats.median}ms；含流程图 ${d.diag.stats.median}ms；到图出现 ${d.diag.diagramMs?.[0] ?? '—'}ms`)
  } else if (mode === 'p03') {
    const r = runMode('p03', path.join(OUT, 'p03'))
    summary.results.p03 = r.data || { error: r.error }
    const d = r.data
    const keys = ['plainPara', 'plainCode', 'diagPara', 'diagCode']
    const ok = d && !d.error && keys.every((k) => d[k]?.stats?.p95 != null && d[k].stats.p95 <= 50)
    verdict(
      'AC-P03',
      '1MB 文件中输入，单次按键 ≤ 50ms（真实按键；正文 / 代码块，含 / 不含流程图）',
      ok,
      d
        ? Object.fromEntries(keys.map((k) => [k, d[k]?.stats]))
        : r.error
    )
    if (d && !d.error) {
      for (const k of keys) console.log(`  P03 ${k} 中位数 ${d[k].stats.median}ms / p95 ${d[k].stats.p95}ms / 最大 ${d[k].stats.max}ms`)
      console.log(`  P03 快速连打（80ms 间隔）中位数 ${d.fastBurst.stats.median}ms，最大 ${d.fastBurst.stats.max}ms`)
      if (d.sizeSweep) console.log('  P03 大小对照：' + d.sizeSweep.map((s) => `${s.kb}KB ${s.stats.median}ms`).join('，'))
    }
  } else if (mode === 'p04') {
    const r = runMode('p04', path.join(OUT, 'p04'))
    summary.results.p04 = r.data || { error: r.error }
    const d = r.data
    // 验收标准写的是「任务管理器」，任务管理器默认的「内存」列就是专用工作集；其余口径一并记录
    const total = d && !d.error ? d.privateWorkingSetMB : null
    verdict(
      'AC-P04',
      '空文档内存 ≤ 250MB（全部进程合计，专用工作集）',
      total != null && total <= 250,
      d
        ? {
            privateWorkingSetMB: d.privateWorkingSetMB,
            workingSetMB: d.workingSetMB,
            privateBytesMB: d.privateBytesMB,
            getProcessWorkingSetMB: d.getProcessWorkingSetMB,
            getProcessPrivateMB: d.getProcessPrivateMB,
            processes: d.processes?.length,
          }
        : r.error
    )
    if (d && !d.error)
      console.log(
        `  P04 专用工作集 ${d.privateWorkingSetMB}MB（任务管理器口径）；工作集合计 ${d.workingSetMB}MB；提交 ${d.privateBytesMB}MB；进程 ${d.processes.length} 个`
      )
  } else if (mode === 'p05') {
    const r = runMode('p05', path.join(OUT, 'p05'), [`--minutes=${MINUTES}`])
    summary.results.p05 = r.data || { error: r.error }
    const d = r.data
    const ok = d && !d.error && !d.lastError && (d.errors?.length || 0) === 0 && (d.crashes?.length || 0) === 0 && d.elapsedMinutes >= MINUTES - 0.2
    verdict(
      'AC-P05',
      `连续使用 ${MINUTES} 分钟无崩溃、无报错`,
      ok,
      d ? { elapsedMinutes: d.elapsedMinutes, iterations: d.iterations, consoleErrors: d.errors?.length, crashes: d.crashes, lastError: d.lastError, trend: d.trend } : r.error
    )
    if (d && !d.error) console.log(`  P05 运行 ${d.elapsedMinutes} 分钟、${d.iterations} 轮；控制台错误 ${d.errors?.length || 0} 条；崩溃 ${d.crashes?.length || 0} 次`)
  } else {
    console.log(`  跳过未知模式：${mode}`)
  }
}

summary.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')

console.log('\n===== 性能验收汇总 =====')
if (summary.dist.stale) console.log('⚠ dist/ 可能比源码旧：先 npm run build 再测，结果才代表安装包里的代码')
for (const v of summary.verdicts) {
  console.log(`${v.pass ? '✅' : '❌'} ${v.id} ${v.desc}`)
  if (!v.pass) console.log('   详情：' + JSON.stringify(v.detail))
}
console.log(`\n结果文件：${path.join(OUT, 'summary.json')}`)
process.exitCode = summary.verdicts.every((v) => v.pass) ? 0 : 1
