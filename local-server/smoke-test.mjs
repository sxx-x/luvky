/**
 * 协议级烟测：创建房间、两个访客进房、一方改播放状态，另一方应立刻收到 NEW_STATUS。
 * 用法：先启动 local-server，再执行 `node local-server/smoke-test.mjs`
 */
import { WebSocket } from "ws"

const BASE = process.env.PT_SMOKE_URL || "http://127.0.0.1:8787"
const WS = BASE.replace(/^http/, "ws") + "/ws"

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

function common(id) {
  return {
    "x-pt-version": "0.10.4-local",
    "x-pt-client": "web",
    "x-pt-stamp": Date.now(),
    "x-pt-language": "zh-CN",
    "x-pt-local-id": id,
  }
}

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS)
    const timer = setTimeout(() => reject(new Error("ws timeout")), 4000)
    const pending = []
    ws.on("message", (raw) => pending.push(JSON.parse(String(raw))))
    ws.pending = pending
    ws.on("open", () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function waitMsg(ws, pred, ms = 4000) {
  return new Promise((resolve, reject) => {
    const pending = ws.pending || []
    const hit = pending.find(pred)
    if (hit) {
      pending.splice(pending.indexOf(hit), 1)
      resolve(hit)
      return
    }
    const timer = setTimeout(() => {
      ws.off("message", onMsg)
      reject(new Error("wait message timeout"))
    }, ms)
    function onMsg(raw) {
      const data = JSON.parse(String(raw))
      if (pred(data)) {
        const idx = pending.indexOf(data)
        if (idx >= 0) pending.splice(idx, 1)
        clearTimeout(timer)
        ws.off("message", onMsg)
        resolve(data)
      }
    }
    ws.on("message", onMsg)
  })
}

async function main() {
  const health = await fetch(BASE + "/health").then((r) => r.json())
  if (!health.ok) throw new Error("health failed")

  const parse = await api("/parse-text", {
    ...common("owner-1"),
    link: BASE + "/demo/tone.mp3",
  })
  if (parse.code !== "0000" || !parse.data?.audioUrl) throw new Error("parse-text failed " + JSON.stringify(parse))

  const created = await api("/room-operate", {
    ...common("owner-1"),
    operateType: "CREATE",
    roomData: parse.data,
    nickName: "房主",
  })
  if (created.code !== "0000") throw new Error("create failed " + JSON.stringify(created))
  const roomId = created.data.roomId

  const enterA = await api("/room-operate", { ...common("owner-1"), operateType: "ENTER", roomId, nickName: "房主" })
  const enterB = await api("/room-operate", { ...common("guest-2"), operateType: "ENTER", roomId, nickName: "听众" })
  if (enterA.code !== "0000" || enterB.code !== "0000") {
    throw new Error("enter failed " + JSON.stringify({ enterA, enterB }))
  }

  const wsA = await openWs()
  const wsB = await openWs()
  await waitMsg(wsA, (d) => d.responseType === "CONNECTED")
  await waitMsg(wsB, (d) => d.responseType === "CONNECTED")

  const firstA = waitMsg(wsA, (d) => d.responseType === "NEW_STATUS")
  const firstB = waitMsg(wsB, (d) => d.responseType === "NEW_STATUS")
  wsA.send(JSON.stringify({ operateType: "FIRST_SEND", roomId, "x-pt-local-id": "owner-1", "x-pt-stamp": Date.now() }))
  wsB.send(JSON.stringify({ operateType: "FIRST_SEND", roomId, "x-pt-local-id": "guest-2", "x-pt-stamp": Date.now() }))
  await firstA
  await firstB

  const gotB = waitMsg(wsB, (d) => d.responseType === "NEW_STATUS" && d.roomStatus?.playStatus === "PLAYING")
  const gotA = waitMsg(wsA, (d) => d.responseType === "NEW_STATUS" && d.roomStatus?.playStatus === "PLAYING")
  wsA.send(JSON.stringify({
    operateType: "SET_PLAYER",
    roomId,
    "x-pt-local-id": "owner-1",
    "x-pt-stamp": Date.now(),
    playStatus: "PLAYING",
    speedRate: "1.2",
    contentStamp: 12345,
  }))
  const statusB = await gotB
  const statusA = await gotA
  if (statusB.roomStatus.contentStamp !== 12345 || statusB.roomStatus.speedRate !== "1.2") {
    throw new Error("guest did not get synced status " + JSON.stringify(statusB))
  }
  if (statusA.roomStatus.playStatus !== "PLAYING") {
    throw new Error("owner did not get echo " + JSON.stringify(statusA))
  }

  const timeRes = await api("/pt-service", { operate: "TIME" })
  if (timeRes.code !== "0000" || typeof timeRes.data?.stamp !== "number") {
    throw new Error("pt-service failed")
  }

  wsA.close()
  wsB.close()
  console.log("SMOKE OK roomId=" + roomId + " playStatus synced to PLAYING @ 12345ms x1.2")
}

main().catch((err) => {
  console.error("SMOKE FAIL", err)
  process.exit(1)
})
