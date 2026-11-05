// 开发模式：启动 Vite 开发服务器，然后启动 Electron 加载它
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const server = await createServer({ server: { port: 5173, strictPort: false } })
await server.listen()
const url = server.resolvedUrls.local[0]
console.log('[dev] vite ready at', url)

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
})
child.on('close', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
