/**
 * 一起听服务。全站一个会话，没有房间号，也没有房主。
 * HTTP：/health、/pt-service、/room-operate、/parse-text。
 * WebSocket：/ws，播放状态立刻广播。会话只存在内存中，进程退出即清空。
 * 定时关闭的截止点记在会话里。到点由本进程暂停并广播 NEW_STATUS，
 * 不依赖页面里的倒计时。
 * 若存在前端构建产物（PT_STATIC_DIR 或 ../dist），同时托管静态资源与 SPA。
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { WebSocketServer } from "ws"
import { parseText } from "./parse-text.mjs"
import {
  createSession,
  normalizeClientId,
  PLAYING_SWEEP_MS,
} from "./session.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultDist = path.resolve(__dirname, "../dist")
const staticDir = process.env.PT_STATIC_DIR
  ? path.resolve(process.env.PT_STATIC_DIR)
  : (fs.existsSync(path.join(defaultDist, "index.html")) ? defaultDist : "")
const serveStatic = Boolean(staticDir)
const PORT = Number(process.env.PORT || process.env.PT_LOCAL_PORT || (serveStatic ? 3000 : 8787))

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let failed = false
    req.on("data", (chunk) => {
      if (failed) return
      size += chunk.length
      if (size > 1_000_000) {
        failed = true
        const err = new Error("body too large")
        err.code = "BODY_TOO_LARGE"
        reject(err)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (failed) return
      if (!chunks.length) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", (err) => {
      if (!failed) reject(err)
    })
  })
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Cache-Control": "no-store",
  })
  res.end(body)
}

function sendCors(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  })
  res.end()
}

function fail(err) {
  if (err?.code === "BODY_TOO_LARGE") return { code: "E4000", errMsg: "BODY_TOO_LARGE" }
  if (err instanceof SyntaxError) return { code: "E4000", errMsg: "BAD_JSON" }
  return null
}

export function createApp(options = {}) {
  const session = options.session || createSession(options.now)
  const fetchImpl = options.fetchImpl || globalThis.fetch
  let closed = false
  let sleepTimer = null

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || "/").split("?")[0]
    if (req.method === "OPTIONS") {
      sendCors(res)
      return
    }
    if (req.method === "GET" && urlPath === "/health") {
      sendJson(res, 200, {
        ok: true,
        stamp: Date.now(),
        participants: session.participantCount(),
        hasContent: session.hasContent(),
      })
      return
    }
    if (req.method === "GET" && urlPath.startsWith("/demo/")) {
      serveDemo(req, res)
      return
    }

    try {
      if (urlPath === "/pt-service") {
        if (req.method !== "POST") {
          sendJson(res, 200, { code: "E4005", errMsg: "METHOD_NOT_ALLOWED" })
          return
        }
        sendJson(res, 200, { code: "0000", data: { stamp: Date.now() } })
        return
      }

      const body = req.method === "POST" ? await readJson(req) : {}
      if (urlPath === "/room-operate") {
        sendJson(res, 200, await handleRoomOperate(body, req.method))
        return
      }
      if (urlPath === "/parse-text") {
        sendJson(res, 200, await handleParseText(body, req.method))
        return
      }
      if (tryServeStatic(req, res)) return
      sendJson(res, 404, { code: "E4004", errMsg: "NOT_FOUND" })
    } catch (err) {
      const known = fail(err)
      if (known) {
        sendJson(res, 200, known)
        return
      }
      console.error("http error:", err)
      sendJson(res, 500, { code: "E5000", errMsg: "SERVER_ERROR" })
    }
  })

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  })

  function wsSend(socket, obj) {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj))
  }

  function broadcast(obj) {
    const msg = JSON.stringify(obj)
    for (const socket of wss.clients) {
      if (socket.readyState === 1 && socket.joined) socket.send(msg)
    }
  }

  function clearSleepTimer() {
    if (!sleepTimer) return
    clearTimeout(sleepTimer)
    sleepTimer = null
  }

  function armSleepTimer() {
    clearSleepTimer()
    const delay = session.sleepDelay()
    if (delay == null) return
    const wait = Math.max(0, Math.min(delay, 2_147_483_647))
    sleepTimer = setTimeout(() => {
      sleepTimer = null
      const fired = publishDueSleep()
      if (!fired) armSleepTimer()
    }, wait)
    if (typeof sleepTimer.unref === "function") sleepTimer.unref()
  }

  function publishDueSleep() {
    const status = session.takeDueSleep()
    if (!status) return false
    clearSleepTimer()
    broadcast({ responseType: "NEW_STATUS", roomStatus: status })
    return true
  }

  function applySleep(clientId, minutes) {
    const result = session.setSleep(clientId, minutes)
    if (result.code !== "0000") return result
    armSleepTimer()
    broadcast({ responseType: "NEW_STATUS", roomStatus: session.roomStatus() })
    return { code: "0000", data: result.data }
  }

  function rejectSocket(socket, payload, closeCode) {
    wsSend(socket, { responseType: "ERROR", ...payload })
    socket.close(closeCode, payload.errMsg || "ERROR")
  }

  async function handleSetContent(clientId, body) {
    if (!session.snapshotFor(clientId)) {
      return { code: "E4003", errMsg: "NOT_IN_SESSION", showMsg: "请先加入一起听" }
    }
    if (typeof body?.link !== "string" || !body.link.trim()) {
      return { code: "E4000", errMsg: "BAD_LINK" }
    }
    const parsed = await parseText(body.link, fetchImpl)
    if (parsed.code !== "0000") return parsed
    const saved = session.setContent(clientId, parsed.data)
    if (saved.code === "0000") {
      broadcast({
        responseType: "NEW_CONTENT",
        content: saved.data.content,
        roomStatus: session.roomStatus(),
      })
    }
    return saved
  }

  async function handleRoomOperate(body, method) {
    if (method !== "POST") return { code: "E4005", errMsg: "METHOD_NOT_ALLOWED" }
    const clientId = normalizeClientId(body?.["x-pt-local-id"])
    if (!clientId) return { code: "E4000", errMsg: "BAD_LOCAL_ID" }
    publishDueSleep()
    const operateType = body.operateType
    if (operateType === "CREATE") return { code: "E4000", errMsg: "CREATE_REMOVED" }
    if (operateType === "ENTER") return session.enter(clientId)
    if (operateType === "HEARTBEAT") return session.heartbeat(clientId)
    if (operateType === "LEAVE") return session.leave(clientId)
    if (operateType === "SET_CONTENT") return handleSetContent(clientId, body)
    if (operateType === "SET_SLEEP") return applySleep(clientId, body?.sleepMinutes)
    return { code: "E4000", errMsg: "BAD_OPERATE" }
  }

  async function handleParseText(body, method) {
    if (method !== "POST") return { code: "E4005", errMsg: "METHOD_NOT_ALLOWED" }
    const clientId = normalizeClientId(body?.["x-pt-local-id"])
    if (!clientId) return { code: "E4000", errMsg: "BAD_LOCAL_ID" }
    if (typeof body?.link !== "string" || !body.link.trim()) {
      return { code: "E4000", errMsg: "BAD_LINK" }
    }
    return parseText(body.link, fetchImpl)
  }

  function handleWsMessage(socket, data) {
    let req
    try {
      req = JSON.parse(String(data))
    } catch {
      socket.close(1003, "BAD_JSON")
      return
    }
    const operateType = req?.operateType
    const clientId = normalizeClientId(req?.["x-pt-local-id"])
    const stamp = req?.["x-pt-stamp"]
    const sleepFired = publishDueSleep()
    if (!operateType || !clientId || typeof stamp !== "number" || !Number.isFinite(stamp)) {
      rejectSocket(socket, { code: "E4000", errMsg: "BAD_MESSAGE" }, 4000)
      return
    }
    if (socket.joined && socket.clientId !== clientId) {
      rejectSocket(socket, { code: "E4000", errMsg: "BAD_LOCAL_ID" }, 4000)
      return
    }

    if (operateType === "HEARTBEAT") {
      if (!socket.joined) {
        rejectSocket(socket, { code: "E4000", errMsg: "NEED_FIRST_SEND" }, 4000)
        return
      }
      wsSend(socket, { responseType: "HEARTBEAT" })
      return
    }

    if (operateType === "FIRST_SEND") {
      const snap = session.snapshotFor(clientId)
      if (!snap) {
        rejectSocket(socket, {
          code: "E4003",
          errMsg: "NOT_IN_SESSION",
          showMsg: "请先加入一起听",
        }, 4003)
        return
      }
      socket.joined = true
      socket.clientId = clientId
      wsSend(socket, {
        responseType: "NEW_STATUS",
        content: snap.content,
        roomStatus: snap.roomStatus,
      })
      return
    }

    if (operateType === "SET_SLEEP") {
      if (!socket.joined) {
        rejectSocket(socket, { code: "E4000", errMsg: "NEED_FIRST_SEND" }, 4000)
        return
      }
      const result = applySleep(clientId, req.sleepMinutes)
      if (result.code === "E4003") {
        rejectSocket(socket, result, 4003)
        return
      }
      if (result.code !== "0000") {
        rejectSocket(socket, { code: "E4000", errMsg: result.errMsg || "BAD_SLEEP" }, 4000)
      }
      return
    }

    if (operateType === "SET_PLAYER") {
      if (!socket.joined) {
        rejectSocket(socket, { code: "E4000", errMsg: "NEED_FIRST_SEND" }, 4000)
        return
      }
      if (sleepFired) return
      if (!req.playStatus || req.speedRate == null || typeof req.contentStamp !== "number") {
        rejectSocket(socket, { code: "E4000", errMsg: "BAD_PLAYER" }, 4000)
        return
      }
      const result = session.setPlayer(clientId, stamp, req)
      if (result.code === "E4003") {
        rejectSocket(socket, result, 4003)
        return
      }
      if (result.code === "0000") {
        broadcast({ responseType: "NEW_STATUS", roomStatus: result.roomStatus })
      }
      return
    }

    rejectSocket(socket, { code: "E4000", errMsg: "BAD_OPERATE" }, 4000)
  }

  wss.on("connection", (socket) => {
    socket.joined = false
    socket.clientId = ""
    socket.on("error", () => {})
    wsSend(socket, { responseType: "CONNECTED" })
    socket.on("message", (data) => {
      try {
        handleWsMessage(socket, data)
      } catch (err) {
        console.error("ws message error:", err)
      }
    })
    // 这里不调用 leave。套接字掉线后，同一个人还能用原来的 x-pt-local-id
    // 在心跳时限内重连，不会被立刻踢出，也不会占第二个名额。
  })

  function sweep() {
    publishDueSleep()
    return session.cleanupPlaying()
  }

  const timer = setInterval(sweep, PLAYING_SWEEP_MS)
  if (typeof timer.unref === "function") timer.unref()
  armSleepTimer()

  function close() {
    if (closed) return Promise.resolve()
    closed = true
    clearInterval(timer)
    clearSleepTimer()
    for (const socket of wss.clients) {
      try { socket.terminate() } catch { /* already gone */ }
    }
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      wss.close()
      if (!server.listening) {
        done()
        return
      }
      server.close(done)
      server.closeAllConnections?.()
      setTimeout(done, 2000).unref?.()
    })
  }

  return { server, session, close, sweep }
}

function serveDemo(req, res) {
  const name = decodeURIComponent(req.url.split("?")[0].replace(/^\/demo\//, ""))
  if (name.includes("..") || name.includes("/")) {
    res.writeHead(404)
    res.end()
    return
  }
  const file = path.join(__dirname, "demo", name)
  if (!fs.existsSync(file)) {
    res.writeHead(404)
    res.end()
    return
  }
  const stat = fs.statSync(file)
  const ext = path.extname(file).toLowerCase()
  const types = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav" }
  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600",
    "Accept-Ranges": "bytes",
  })
  fs.createReadStream(file).pipe(res)
}

const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
}

function resolveStaticFile(urlPath) {
  if (!serveStatic) return null
  let decoded
  try {
    decoded = decodeURIComponent((urlPath || "/").split("?")[0])
  } catch {
    return null
  }
  if (!decoded || decoded === "/") decoded = "/index.html"
  const file = path.normalize(path.join(staticDir, decoded))
  const root = staticDir.endsWith(path.sep) ? staticDir : staticDir + path.sep
  if (file !== staticDir && !file.startsWith(root)) return null
  return file
}

function tryServeStatic(req, res) {
  if (!serveStatic) return false
  if (req.method !== "GET" && req.method !== "HEAD") return false
  let file = resolveStaticFile(req.url || "/")
  if (!file) return false

  let stat
  try {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      stat = fs.statSync(file)
    } else {
      const ext = path.extname(file)
      if (ext && ext !== ".html") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("Not found")
        return true
      }
      const index = path.join(staticDir, "index.html")
      if (!fs.existsSync(index)) return false
      file = index
      stat = fs.statSync(index)
    }
  } catch {
    return false
  }

  const ext = path.extname(file).toLowerCase()
  const headers = {
    "Content-Type": STATIC_MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
  }
  if (ext === ".html") {
    headers["Cache-Control"] = "no-cache"
  } else if (/\.[0-9a-f]{8}\./i.test(path.basename(file))) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable"
  } else {
    headers["Cache-Control"] = "public, max-age=3600"
  }
  res.writeHead(200, headers)
  if (req.method === "HEAD") {
    res.end()
    return true
  }
  fs.createReadStream(file).pipe(res)
  return true
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isMainModule()) {
  const { server } = createApp()
  server.listen(PORT, "0.0.0.0", () => {
    const address = server.address()
    const actualPort = address && typeof address === "object" ? address.port : PORT
    console.log(`[local-server] http://0.0.0.0:${actualPort}`)
    console.log(`[local-server] websocket ws://0.0.0.0:${actualPort}/ws`)
    if (serveStatic) console.log(`[local-server] static      ${staticDir}`)
    console.log(`[local-server] demo audio  /demo/tone.mp3`)
  })
}
