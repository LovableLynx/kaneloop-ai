import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VITE_BIN = path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js')

const DEV_SERVER_URL = 'http://localhost:5173'
const BRIDGE_URL = 'http://localhost:8787'

function waitForServer(url, label, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`${label} did not become ready within ${timeoutMs}ms`))
          return
        }
        setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? 'start'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open'
  const args = process.platform === 'win32' ? ['', url] : [url]
  spawn(cmd, args, { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref()
}

console.log('Starting kane-bridge (port 8787) and Vite dev server (port 5173)...\n')

// Invoke Vite's JS entrypoint directly via `node`, bypassing npm.cmd's
// batch-file shim on Windows (spawn() can't exec .cmd files without
// shell:true, which we're avoiding — same reasoning as kane-bridge.mjs's
// direct kane-cli.cjs invocation).
const bridge = spawn(process.execPath, [path.join(__dirname, 'kane-bridge.mjs')], {
  stdio: 'inherit',
})
const dev = spawn(process.execPath, [VITE_BIN], { stdio: 'inherit', cwd: __dirname })

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  bridge.kill()
  dev.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
bridge.on('close', shutdown)
dev.on('close', shutdown)

;(async () => {
  try {
    await Promise.all([
      waitForServer(BRIDGE_URL, 'kane-bridge'),
      waitForServer(DEV_SERVER_URL, 'Vite dev server'),
    ])
    console.log(`\nBoth servers ready — opening ${DEV_SERVER_URL}\n`)
    openBrowser(DEV_SERVER_URL)
  } catch (err) {
    console.error(`\n${err.message}`)
    console.error('Servers are still running — open http://localhost:5173 manually once ready.')
  }
})()
