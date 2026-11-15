/**
 * 房间服务：替代原项目依赖的 Laf 云函数。
 * 提供 /room-operate、/parse-text、/pt-service，以及 /ws 实时同步。
 * 若存在前端构建产物（PT_STATIC_DIR 或 ../dist），同时在同一端口托管静态资源与 SPA。
 * 房间数据仅存在内存中，进程退出即清空。
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"
import { WebSocketServer } from "ws"
import { parseText } from "./parse-text.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultDist = path.resolve(__dirname, "../dist")
const staticDir = process.env.PT_STATIC_DIR
  ? path.resolve(process.env.PT_STATIC_DIR)
  : (fs.existsSync(path.join(defaultDist, "index.html")) ? defaultDist : "")
const serveStatic = Boolean(staticDir)
const PORT = Number(process.env.PORT || process.env.PT_LOCAL_PORT || (serveStatic ? 3000 : 8787))
const MAX_ROOM_NUM = 15
const MIN_DURATION_FOR_A_PERSON = 250
const SPEED_RATES = new Set(["0.8", "1", "1.2", "1.5", "1.7"])

const defaultRoomCfg = { everyoneCanOperatePlayer: "Y" }

/** @type {Map<string, any>} */
const rooms = new Map()

function now() {
  return Date.now()
}

function makeId(bytes = 8) {
  return randomBytes(bytes).toString("hex")
}

function generateGuestId(participants) {
  const ABC = "abcdefghijkmnopqrstuvwyz123456789"
  const ids = new Set(participants.map((v) => v.guestId))
  for (let t = 0; t < 20; t++) {
    let s = ""
    for (let i = 0; i < 11; i++) s += ABC[Math.floor(Math.random() * ABC.length)]
    if (!ids.has(s)) return s
  }
  return makeId(6)
}

function publicRoom(room, extra = {}) {
  return {
    roomId: room._id,
    content: room.content,
    playStatus: room.playStatus,
    speedRate: room.speedRate,
    operator: room.operator,
    contentStamp: room.contentStamp,
    operateStamp: room.operateStamp,
    participants: (room.participants || []).map((v) => ({
      nickName: v.nickName,
      guestId: v.guestId,
      heartbeatStamp: v.heartbeatStamp,
      enterStamp: v.enterStamp,
    })),
    everyoneCanOperatePlayer: (room.config || defaultRoomCfg).everyoneCanOperatePlayer,
    ...extra,
  }
}

function pausePlayer(room, operator = "") {
  if (room.playStatus === "PAUSED") return room
  room.playStatus = "PAUSED"
  const participants = room.participants || []
  let { operateStamp, speedRate, contentStamp } = room
  let speedRateNum = Number(speedRate)
  if (isNaN(speedRateNum) || speedRateNum >= 1.71) speedRateNum = 1
  if (participants.length > 0) {
    let lastHeartbeat = operateStamp
    for (const p of participants) {
      if (p.heartbeatStamp > lastHeartbeat) lastHeartbeat = p.heartbeatStamp
    }
    room.contentStamp = contentStamp + (lastHeartbeat - operateStamp) * speedRateNum
    room.operateStamp = now()
    room.operator = operator
  }
  return room
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (c) => {
      size += c.length
      if (size > 1_000_000) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
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
    req.on("error", reject)
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

function handleCreate(body) {
  const clientId = body["x-pt-local-id"]
  const roomData = body.roomData
  if (!roomData || roomData.infoType !== "podcast" || !roomData.audioUrl) {
    return { code: "E4000", errMsg: "roomData.audioUrl is required" }
  }
  // 同一位房主再建新房时，关掉旧房（与原云函数一致）
  for (const [id, room] of rooms) {
    if (room.oState === "OK" && room.owner === clientId) {
      pausePlayer(room)
      room.oState = "DELETED"
      room.participants = []
      rooms.set(id, room)
    }
  }
  const id = makeId(12)
  const stamp = now()
  const room = {
    _id: id,
    content: roomData,
    oState: "OK",
    playStatus: "PAUSED",
    speedRate: "1",
    contentStamp: 0,
    operateStamp: stamp,
    operator: "",
    createStamp: stamp,
    owner: clientId,
    participants: [],
    config: { ...defaultRoomCfg },
  }
  rooms.set(id, room)
  return { code: "0000", data: publicRoom(room) }
}

function handleEnter(body) {
  const clientId = body["x-pt-local-id"]
  const { roomId, nickName } = body
  const room = rooms.get(roomId)
  if (!room || room.oState === "DELETED") return { code: "E4004" }
  if (room.oState === "EXPIRED") return { code: "E4006" }

  const stamp = now()
  let me = room.participants.find((v) => v.nonce === clientId)
  let guestId = ""
  if (me) {
    guestId = me.guestId
    me.nickName = nickName
    me.enterStamp = stamp
    me.heartbeatStamp = stamp
  } else {
    if (room.participants.length >= MAX_ROOM_NUM) return { code: "R0001" }
    guestId = generateGuestId(room.participants)
    me = {
      nickName,
      enterStamp: stamp,
      heartbeatStamp: stamp,
      guestId,
      nonce: clientId,
    }
    room.participants.push(me)
  }
  room.participants = room.participants.filter((v) => stamp - v.heartbeatStamp < 60 * 1000)
  return {
    code: "0000",
    data: publicRoom(room, {
      guestId,
      iamOwner: room.owner === clientId ? "Y" : "N",
    }),
  }
}

function handleHeartbeat(body) {
  const clientId = body["x-pt-local-id"]
  const { roomId, nickName } = body
  const room = rooms.get(roomId)
  if (!room || room.oState === "DELETED") return { code: "E4004" }
  if (room.oState === "EXPIRED") return { code: "E4006" }
  const stamp = now()
  const me = room.participants.find((v) => v.nonce === clientId)
  if (!me) return { code: "E4003" }
  me.heartbeatStamp = stamp
  me.nickName = nickName
  room.participants = room.participants.filter((v) => stamp - v.heartbeatStamp < 50 * 1000)
  return { code: "0000", data: publicRoom(room) }
}

function handleLeave(body) {
  const clientId = body["x-pt-local-id"]
  const { roomId } = body
  const room = rooms.get(roomId)
  if (!room || room.oState === "DELETED") return { code: "E4004" }
  if (room.oState === "EXPIRED") return { code: "E4006" }
  if (room.participants.length < 1) return { code: "0000" }
  const me = room.participants.find((v) => v.nonce === clientId)
  if (!me) return { code: "E4003" }
  if (room.participants.length === 1) {
    pausePlayer(room)
    room.participants = []
    return { code: "0000" }
  }
  room.participants = room.participants.filter((v) => v.nonce !== clientId)
  return { code: "0000" }
}

function handleRoomOperate(body, method) {
  if (method !== "POST") return { code: "E4005" }
  const localId = body["x-pt-local-id"]
  if (!localId) return { code: "E4000" }
  const { operateType = "", nickName, roomId } = body
  const oTypes = ["CREATE", "ENTER", "HEARTBEAT", "LEAVE"]
  if (!oTypes.includes(operateType)) return { code: "E4000" }
  if (!nickName && operateType !== "CREATE") return { code: "E4000" }
  if (!roomId && operateType !== "CREATE") return { code: "E4000" }
  if (operateType === "CREATE") return handleCreate(body)
  if (operateType === "ENTER") return handleEnter(body)
  if (operateType === "HEARTBEAT") return handleHeartbeat(body)
  if (operateType === "LEAVE") return handleLeave(body)
  return { code: "E4044" }
}

function cleanupPlayingRooms() {
  const stamp = now()
  for (const room of rooms.values()) {
    if (room.oState !== "OK" || room.playStatus !== "PLAYING") continue
    const oldLen = room.participants.length
    if (oldLen < 1) {
      room.playStatus = "PAUSED"
      continue
    }
    let lastHeartbeat = 1
    room.participants = room.participants.filter((p) => {
      if (p.heartbeatStamp > lastHeartbeat) lastHeartbeat = p.heartbeatStamp
      return p.heartbeatStamp > stamp - 50 * 1000
    })
    if (room.participants.length === oldLen) continue
    if (room.participants.length === 0) {
      let speedRateNum = Number(room.speedRate)
      if (isNaN(speedRateNum) || speedRateNum >= 1.71) speedRateNum = 1
      room.playStatus = "PAUSED"
      room.contentStamp = room.contentStamp + (lastHeartbeat - room.operateStamp) * speedRateNum
      room.operateStamp = stamp
      room.operator = ""
    }
  }
}

setInterval(cleanupPlayingRooms, 30_000)

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
      // Hashed or real assets that are missing should 404; route navigations fall back to SPA.
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

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0]
  if (req.method === "OPTIONS") {
    sendCors(res)
    return
  }
  if (req.method === "GET" && urlPath === "/health") {
    sendJson(res, 200, { ok: true, rooms: rooms.size, stamp: now() })
    return
  }
  if (req.method === "GET" && urlPath.startsWith("/demo/")) {
    serveDemo(req, res)
    return
  }

  try {
    if (urlPath === "/pt-service" && req.method === "POST") {
      sendJson(res, 200, { code: "0000", data: { stamp: now() } })
      return
    }
    const body = req.method === "POST" ? await readJson(req) : {}
    if (urlPath === "/room-operate") {
      sendJson(res, 200, handleRoomOperate(body, req.method))
      return
    }
    if (urlPath === "/parse-text") {
      if (req.method !== "POST") {
        sendJson(res, 200, { code: "E4005" })
        return
      }
      const { link } = body
      const clientId = body["x-pt-local-id"]
      if (!link || !clientId || String(link).indexOf("http") !== 0) {
        sendJson(res, 200, { code: "E4000" })
        return
      }
      sendJson(res, 200, await parseText(String(link)))
      return
    }
    if (tryServeStatic(req, res)) return
    sendJson(res, 404, { code: "E4004" })
  } catch (err) {
    console.error("http error:", err)
    sendJson(res, 500, { code: "E5000", errMsg: "server error" })
  }
})

const wss = new WebSocketServer({ server, path: "/ws" })

function wsSend(socket, obj) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(obj))
  }
}

function broadcastRoom(roomId, obj) {
  const msg = JSON.stringify(obj)
  for (const socket of wss.clients) {
    if (socket.readyState === 1 && socket.roomId === roomId) {
      socket.send(msg)
    }
  }
}

function getOperatorGuestId(clientId, room) {
  if (!room || room.oState === "EXPIRED" || room.oState === "DELETED") return
  const me = (room.participants || []).find((v) => v.nonce === clientId)
  return me?.guestId
}

function handleWsMessage(socket, data) {
  let req
  try {
    req = JSON.parse(String(data))
  } catch {
    socket.close()
    return
  }
  const operateType = req?.operateType
  const roomId = req?.roomId
  const clientId = req?.["x-pt-local-id"]
  const stamp = req?.["x-pt-stamp"]
  if (!operateType || !roomId || !clientId || !stamp) {
    socket.close()
    return
  }

  if (operateType === "HEARTBEAT") {
    if (!socket.roomId || socket.roomId !== roomId) {
      socket.close()
      return
    }
    wsSend(socket, { responseType: "HEARTBEAT" })
    return
  }

  if (operateType === "FIRST_SEND") {
    const room = rooms.get(roomId)
    const guestId = getOperatorGuestId(clientId, room)
    if (!guestId) {
      socket.close()
      return
    }
    socket.roomId = roomId
    wsSend(socket, {
      responseType: "NEW_STATUS",
      roomStatus: {
        roomId,
        playStatus: room.playStatus,
        speedRate: room.speedRate,
        operator: room.operator,
        contentStamp: room.contentStamp,
        operateStamp: room.operateStamp,
        everyoneCanOperatePlayer: (room.config || defaultRoomCfg).everyoneCanOperatePlayer,
      },
    })
    return
  }

  if (operateType === "SET_PLAYER") {
    const { playStatus, speedRate, contentStamp, everyoneCanOperatePlayer } = req
    if (!playStatus || !speedRate || typeof contentStamp !== "number") {
      socket.close()
      return
    }
    if (!SPEED_RATES.has(String(speedRate))) return
    const room = rooms.get(roomId)
    if (!room) return
    const roomCfg = room.config || { ...defaultRoomCfg }
    const isOwner = room.owner === clientId
    if (!isOwner && roomCfg.everyoneCanOperatePlayer === "N") return
    const guestId = getOperatorGuestId(clientId, room)
    if (!guestId) {
      socket.close()
      return
    }
    if (guestId === room.operator && stamp - room.operateStamp < MIN_DURATION_FOR_A_PERSON) return

    room.playStatus = playStatus
    room.speedRate = String(speedRate)
    room.contentStamp = contentStamp
    room.operateStamp = stamp
    room.operator = guestId
    const roomStatus = {
      roomId,
      playStatus,
      speedRate: room.speedRate,
      contentStamp,
      operateStamp: stamp,
      operator: guestId,
    }
    if (everyoneCanOperatePlayer && isOwner) {
      roomStatus.everyoneCanOperatePlayer = everyoneCanOperatePlayer
      roomCfg.everyoneCanOperatePlayer = everyoneCanOperatePlayer
      room.config = roomCfg
    }
    broadcastRoom(roomId, { responseType: "NEW_STATUS", roomStatus })
  }
}

wss.on("connection", (socket) => {
  socket.createStamp = now()
  wsSend(socket, { responseType: "CONNECTED" })
  socket.on("message", (data) => {
    try {
      handleWsMessage(socket, data)
    } catch (err) {
      console.error("ws message error:", err)
    }
  })
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[local-server] http://0.0.0.0:${PORT}`)
  console.log(`[local-server] websocket ws://0.0.0.0:${PORT}/ws`)
  if (serveStatic) console.log(`[local-server] static      ${staticDir}`)
  console.log(`[local-server] demo audio  /demo/tone.mp3`)
})
