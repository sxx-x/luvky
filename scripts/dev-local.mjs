/**
 * 同时启动本地房间服务和 Vite 开发服务器。
 * PT_DEV_HTTPS=0 可关闭 mkcert，方便用 http://局域网IP:5173 在 iPhone 上打开。
 */
import { spawn } from "node:child_process"
import os from "node:os"
import http from "node:http"

const serverPort = Number(process.env.PT_LOCAL_PORT || 8787)
const useHttps = process.env.PT_DEV_HTTPS !== "0"

function lanIPs() {
  const out = []
  const ifs = os.networkInterfaces()
  for (const list of Object.values(ifs)) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) out.push(item.address)
    }
  }
  return out
}

function waitHealth(timeoutMs = 15000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${serverPort}/health`, (res) => {
        if (res.statusCode === 200) {
          res.resume()
          resolve(true)
          return
        }
        res.resume()
        retry()
      })
      req.on("error", retry)
    }
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("local-server did not become ready"))
        return
      }
      setTimeout(tick, 200)
    }
    tick()
  })
}

const children = []

function run(cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  })
  children.push(child)
  child.on("exit", (code, signal) => {
    if (shuttingDown) return
    if (signal) return
    if (code && code !== 0) {
      console.error(`[dev-local] ${cmd} ${args.join(" ")} exited ${code}`)
      shutdown(code)
    }
  })
  return child
}

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    try { c.kill("SIGTERM") } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(code), 200)
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

run("node", ["local-server/index.mjs"])

try {
  await waitHealth()
} catch (err) {
  console.error(err.message || err)
  shutdown(1)
  process.exit(1)
}

run("npx", ["vite"], useHttps ? {} : { PT_DEV_HTTPS: "0" })

const ips = lanIPs()
const proto = useHttps ? "https" : "http"
console.log("")
console.log("==============================================")
console.log("  一起听播客 · 本地开发（含房间服务）")
console.log("  本机:  " + proto + "://127.0.0.1:5173")
for (const ip of ips) {
  console.log("  局域网 iPhone:  " + proto + "://" + ip + ":5173")
}
if (useHttps) {
  console.log("  如 iPhone 打不开证书，可用: PT_DEV_HTTPS=0 pnpm dev")
}
console.log("==============================================")
console.log("")
