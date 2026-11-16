/**
 * 协议烟测：单进程里的 HTTP / WebSocket，以及真正重启进程后会话被清空。
 * 用法：node --test local-server/smoke-test.mjs
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { WebSocket } from "ws"
import { createApp } from "./index.mjs"

const ID = "5e280fb0418a84a0461f7c2e"
const EPISODE_URL = `https://www.xiaoyuzhoufm.com/episode/${ID}`
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LEGACY_KEYS = [
  "nickName",
  "roomId",
  "iamOwner",
  "everyoneCanOperatePlayer",
  "owner",
  "volume",
  "muted",
  "oState",
]

function episodeHtml() {
  return `<!doctype html><html><head>
<meta property="og:title" content="测试单集">
<meta property="og:description" content="一起听">
<meta property="og:image" content="https://image.xyzcdn.net/cover.jpg">
<meta property="og:audio" content="https://media.xyzcdn.net/test-episode.m4a">
<meta property="og:url" content="${EPISODE_URL}">
<meta property="og:site_name" content="小宇宙">
<meta name="application-name" content="小宇宙">
<title>测试单集</title>
<script name="schema:podcast-show" type="application/ld+json">{"url":"${EPISODE_URL}","description":"详细简介","partOfSeries":{"name":"商业就是这样","url":"https://www.xiaoyuzhoufm.com/podcast/5e280fa8418a84a0461f6c2e"}}</script>
</head><body></body></html>`
}

function mockFetch(url) {
  const href = String(url)
  if (href.startsWith("https://www.xiaoyuzhoufm.com/episode/") || href.startsWith("https://xiaoyuzhoufm.com/episode/")) {
    return Promise.resolve(new Response(episodeHtml(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }))
  }
  return Promise.resolve(new Response("no", { status: 404 }))
}

function assertNoLegacy(value) {
  const keys = new Set()
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    for (const [key, child] of Object.entries(node)) {
      keys.add(key)
      walk(child)
    }
  }
  walk(value)
  for (const key of LEGACY_KEYS) assert.equal(keys.has(key), false, key)
}

async function withServer(fn, fetchImpl = mockFetch) {
  const app = createApp({ fetchImpl })
  try {
    await new Promise((resolve, reject) => {
      app.server.once("error", reject)
      app.server.listen(0, "127.0.0.1", resolve)
    })
    const port = app.server.address().port
    await fn({
      base: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      app,
    })
  } finally {
    await app.close()
  }
}

async function post(base, pathname, body) {
  const res = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = []
    const waiters = []
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 4000)
    ws.on("error", (err) => {
      if (ws.readyState === WebSocket.CONNECTING) {
        clearTimeout(timer)
        reject(err)
      }
    })
    ws.on("message", (raw) => {
      const data = JSON.parse(String(raw))
      const index = waiters.findIndex((waiter) => waiter.pred(data))
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(data)
        return
      }
      pending.push(data)
    })
    ws.waitFor = (pred, ms = 1000) => new Promise((resolveWait, rejectWait) => {
      const hit = pending.findIndex(pred)
      if (hit >= 0) {
        resolveWait(pending.splice(hit, 1)[0])
        return
      }
      const waiter = {
        pred,
        resolve: resolveWait,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          rejectWait(new Error("wait message timeout; pending=" + JSON.stringify(pending)))
        }, ms),
      }
      waiters.push(waiter)
    })
    ws.on("open", () => {
      clearTimeout(timer)
      resolve(ws)
    })
  })
}

async function enter(base, localId, extra = {}) {
  return post(base, "/room-operate", {
    operateType: "ENTER",
    "x-pt-local-id": localId,
    ...extra,
  })
}

async function joinSocket(wsUrl, localId) {
  const ws = await openWs(wsUrl)
  const connected = await ws.waitFor((msg) => msg.responseType === "CONNECTED")
  assert.deepEqual(connected, { responseType: "CONNECTED" })
  const status = ws.waitFor((msg) => msg.responseType === "NEW_STATUS")
  ws.send(JSON.stringify({
    operateType: "FIRST_SEND",
    "x-pt-local-id": localId,
    "x-pt-stamp": Date.now(),
    roomId: "ignored-room",
    nickName: "ignored-name",
  }))
  return { ws, first: await status }
}

test("health describes the single session and no longer reports rooms", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(base + "/health")
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(typeof body.stamp, "number")
    assert.equal(body.participants, 0)
    assert.equal(body.hasContent, false)
    assert.equal("rooms" in body, false)
  })
})

test("two clients join the same session without a room code or nickname", async () => {
  await withServer(async ({ base }) => {
    const created = await post(base, "/room-operate", {
      operateType: "CREATE",
      "x-pt-local-id": "browser-a",
      nickName: "房主",
      roomData: { infoType: "podcast", audioUrl: "https://example.com/a.mp3" },
    })
    assert.equal(created.status, 200)
    assert.deepEqual(created.body, { code: "E4000", errMsg: "CREATE_REMOVED" })

    const a = await enter(base, "browser-a", { nickName: "房主", roomId: "room-111" })
    const b = await enter(base, "browser-b", { nickName: "听众", roomId: "room-222" })
    assert.equal(a.body.code, "0000")
    assert.equal(b.body.code, "0000")
    assert.equal(a.body.data.participants.length, 1)
    assert.equal(b.body.data.participants.length, 2)
    assert.equal(a.body.data.content, null)
    assert.equal(b.body.data.content, null)
    assert.deepEqual(
      b.body.data.participants.map((item) => item.guestId).sort(),
      [a.body.data.guestId, b.body.data.guestId].sort(),
    )
    assertNoLegacy(a.body)
    assertNoLegacy(b.body)
    assert.equal(JSON.stringify(b.body).includes("房主"), false)
    assert.equal(JSON.stringify(b.body).includes("听众"), false)
    assert.equal(JSON.stringify(b.body).includes("room-111"), false)

    const refresh = await enter(base, "browser-a", { nickName: "" })
    assert.equal(refresh.body.data.guestId, a.body.data.guestId)
    assert.equal(refresh.body.data.participants.length, 2)

    const third = await enter(base, "browser-c")
    assert.equal(third.status, 200)
    assert.deepEqual(third.body, {
      code: "R0001",
      errMsg: "SESSION_FULL",
      showMsg: "已经有两个人在一起听了",
    })

    const health = await fetch(base + "/health").then((res) => res.json())
    assert.equal(health.participants, 2)
    assert.equal(health.hasContent, false)
  })
})

test("concurrent joins still cap the session at two people", async () => {
  await withServer(async ({ base }) => {
    const results = await Promise.all([
      enter(base, "browser-a"),
      enter(base, "browser-b"),
      enter(base, "browser-c"),
    ])
    assert.equal(results.filter((item) => item.body.code === "0000").length, 2)
    assert.equal(results.filter((item) => item.body.errMsg === "SESSION_FULL").length, 1)
    const health = await fetch(base + "/health").then((res) => res.json())
    assert.equal(health.participants, 2)
  })
  await withServer(async ({ base }) => {
    const first = await enter(base, "same-browser")
    const [left, right] = await Promise.all([
      enter(base, "same-browser"),
      enter(base, "same-browser"),
    ])
    assert.equal(left.body.code, "0000")
    assert.equal(right.body.code, "0000")
    assert.equal(left.body.data.guestId, first.body.data.guestId)
    assert.equal(right.body.data.guestId, first.body.data.guestId)
    assert.equal(left.body.data.participants.length, 1)
    const health = await fetch(base + "/health").then((res) => res.json())
    assert.equal(health.participants, 1)
  })
})

test("xiaoyuzhou paste is previewable, then both people see the same episode", async () => {
  let fetches = 0
  const countingFetch = async (url, init) => {
    fetches += 1
    return mockFetch(url, init)
  }
  await withServer(async ({ base, wsUrl }) => {
    const outsider = await post(base, "/room-operate", {
      operateType: "SET_CONTENT",
      "x-pt-local-id": "browser-a",
      link: EPISODE_URL,
    })
    assert.equal(outsider.body.errMsg, "NOT_IN_SESSION")
    assert.equal(fetches, 0)

    await enter(base, "browser-a")
    await enter(base, "browser-b")
    const { ws: wsB } = await joinSocket(wsUrl, "browser-b")
    try {
      const preview = await post(base, "/parse-text", {
        "x-pt-local-id": "browser-a",
        link: EPISODE_URL,
      })
      assert.equal(preview.body.code, "0000")
      assert.equal(preview.body.data.sourceType, "xiaoyuzhou")
      assert.equal(preview.body.data.audioUrl, "https://media.xyzcdn.net/test-episode.m4a")
      assert.equal(preview.body.data.title, "测试单集")
      let health = await fetch(base + "/health").then((res) => res.json())
      assert.equal(health.hasContent, false)

      const blocked = await post(base, "/parse-text", {
        "x-pt-local-id": "browser-a",
        link: "https://podcasts.apple.com/cn/podcast/id1",
      })
      assert.equal(blocked.body.errMsg, "XIAOYUZHOU_EPISODE_ONLY")
      const direct = await post(base, "/room-operate", {
        operateType: "SET_CONTENT",
        "x-pt-local-id": "browser-a",
        link: base + "/demo/tone.mp3",
      })
      assert.equal(direct.body.errMsg, "XIAOYUZHOU_EPISODE_ONLY")

      const incoming = wsB.waitFor((msg) => msg.responseType === "NEW_CONTENT")
      const saved = await post(base, "/room-operate", {
        operateType: "SET_CONTENT",
        "x-pt-local-id": "browser-a",
        link: EPISODE_URL + "?s=share",
        nickName: "房主",
        roomId: "nope",
      })
      assert.equal(saved.body.code, "0000")
      assert.equal(saved.body.data.playStatus, "PAUSED")
      assert.equal(saved.body.data.speedRate, "1")
      assert.equal(saved.body.data.contentStamp, 0)
      assert.equal(saved.body.data.operator, "")
      assert.equal(saved.body.data.content.linkUrl, EPISODE_URL)
      assertNoLegacy(saved.body)

      const pushed = await incoming
      assert.equal(pushed.content.audioUrl, saved.body.data.content.audioUrl)
      assert.equal(pushed.roomStatus.playStatus, "PAUSED")
      assertNoLegacy(pushed)

      const seenByB = await post(base, "/room-operate", {
        operateType: "HEARTBEAT",
        "x-pt-local-id": "browser-b",
      })
      assert.equal(seenByB.body.data.content.audioUrl, "https://media.xyzcdn.net/test-episode.m4a")
      assert.equal(seenByB.body.data.guestId.length > 0, true)
      health = await fetch(base + "/health").then((res) => res.json())
      assert.equal(health.hasContent, true)
      assert.equal(health.participants, 2)
    } finally {
      wsB.close()
    }
  }, countingFetch)
})

test("play, pause, seek, and rate reach the other person within a second", async () => {
  await withServer(async ({ base, wsUrl }) => {
    const a = await enter(base, "browser-a")
    const b = await enter(base, "browser-b")
    await post(base, "/room-operate", {
      operateType: "SET_CONTENT",
      "x-pt-local-id": "browser-a",
      link: EPISODE_URL,
    })
    const left = await joinSocket(wsUrl, "browser-a")
    const right = await joinSocket(wsUrl, "browser-b")
    const sockets = [left.ws, right.ws]
    try {
      assert.equal(left.first.content.audioUrl, "https://media.xyzcdn.net/test-episode.m4a")
      assert.equal(right.first.roomStatus.playStatus, "PAUSED")
      assert.deepEqual(Object.keys(right.first.roomStatus).sort(), [
        "contentStamp",
        "operateStamp",
        "operator",
        "playStatus",
        "speedRate",
      ])

      const stamp = Date.now()
      const playingOnB = right.ws.waitFor((msg) => msg.responseType === "NEW_STATUS" && msg.roomStatus.playStatus === "PLAYING")
      const playingOnA = left.ws.waitFor((msg) => msg.responseType === "NEW_STATUS" && msg.roomStatus.playStatus === "PLAYING")
      left.ws.send(JSON.stringify({
        operateType: "SET_PLAYER",
        "x-pt-local-id": "browser-a",
        "x-pt-stamp": stamp,
        playStatus: "PLAYING",
        speedRate: "1",
        contentStamp: 0,
        volume: 0.2,
        muted: true,
        everyoneCanOperatePlayer: "N",
        roomId: "ignored",
      }))
      const playedB = await playingOnB
      const playedA = await playingOnA
      assert.equal(playedB.roomStatus.operateStamp, stamp)
      assert.equal(playedB.roomStatus.operator, a.body.data.guestId)
      assert.equal("content" in playedB, false)
      assertNoLegacy(playedB)
      assert.equal(playedA.roomStatus.playStatus, "PLAYING")

      const pausedOnA = left.ws.waitFor((msg) => msg.roomStatus?.playStatus === "PAUSED" && msg.roomStatus.contentStamp === 42000)
      right.ws.send(JSON.stringify({
        operateType: "SET_PLAYER",
        "x-pt-local-id": "browser-b",
        "x-pt-stamp": stamp + 300,
        playStatus: "PAUSED",
        speedRate: "1.5",
        contentStamp: 42000,
      }))
      const paused = await pausedOnA
      assert.equal(paused.roomStatus.speedRate, "1.5")
      assert.equal(paused.roomStatus.operator, b.body.data.guestId)

      const soughtOnB = right.ws.waitFor((msg) => msg.roomStatus?.contentStamp === 88000 && msg.roomStatus.playStatus === "PLAYING")
      left.ws.send(JSON.stringify({
        operateType: "SET_PLAYER",
        "x-pt-local-id": "browser-a",
        "x-pt-stamp": stamp + 600,
        playStatus: "PLAYING",
        speedRate: 1.2,
        contentStamp: 88000,
      }))
      const sought = await soughtOnB
      assert.equal(sought.roomStatus.speedRate, "1.2")
      assert.equal(sought.roomStatus.operator, a.body.data.guestId)

      const before = Date.now()
      right.ws.send(JSON.stringify({
        operateType: "HEARTBEAT",
        "x-pt-local-id": "browser-b",
        "x-pt-stamp": Date.now(),
      }))
      const beat = await right.ws.waitFor((msg) => msg.responseType === "HEARTBEAT")
      assert.deepEqual(beat, { responseType: "HEARTBEAT" })
      assert.ok(Date.now() - before < 1000)

      left.ws.send(JSON.stringify({
        operateType: "SET_PLAYER",
        "x-pt-local-id": "browser-a",
        "x-pt-stamp": stamp + 700,
        playStatus: "PLAYING",
        speedRate: "2",
        contentStamp: 1,
      }))
      await new Promise((resolve) => setTimeout(resolve, 200))
      const snapshot = await post(base, "/room-operate", {
        operateType: "HEARTBEAT",
        "x-pt-local-id": "browser-b",
      })
      assert.equal(snapshot.body.data.contentStamp, 88000)
      assert.equal(snapshot.body.data.speedRate, "1.2")
      assert.equal(snapshot.body.data.playStatus, "PLAYING")
    } finally {
      for (const ws of sockets) ws.close()
    }
  })
})

test("a dropped socket keeps the seat, and the same browser can reconnect", async () => {
  await withServer(async ({ base, wsUrl }) => {
    const a = await enter(base, "browser-a")
    await enter(base, "browser-b")
    await post(base, "/room-operate", {
      operateType: "SET_CONTENT",
      "x-pt-local-id": "browser-a",
      link: EPISODE_URL,
    })
    const first = await joinSocket(wsUrl, "browser-a")
    const other = await joinSocket(wsUrl, "browser-b")
    try {
      const stamp = Date.now()
      other.ws.send(JSON.stringify({
        operateType: "SET_PLAYER",
        "x-pt-local-id": "browser-b",
        "x-pt-stamp": stamp,
        playStatus: "PLAYING",
        speedRate: "1",
        contentStamp: 1500,
      }))
      await first.ws.waitFor((msg) => msg.roomStatus?.playStatus === "PLAYING")
      first.ws.close()
      await new Promise((resolve) => setTimeout(resolve, 50))

      const third = await enter(base, "browser-c")
      assert.equal(third.body.errMsg, "SESSION_FULL")

      const refresh = await enter(base, "browser-a")
      assert.equal(refresh.body.data.guestId, a.body.data.guestId)
      assert.equal(refresh.body.data.participants.length, 2)
      assert.equal(refresh.body.data.playStatus, "PLAYING")
      assert.equal(refresh.body.data.contentStamp, 1500)

      const again = await joinSocket(wsUrl, "browser-a")
      try {
        assert.equal(again.first.roomStatus.playStatus, "PLAYING")
        assert.equal(again.first.roomStatus.contentStamp, 1500)
        assert.equal(again.first.content.audioUrl, "https://media.xyzcdn.net/test-episode.m4a")
        const paused = again.ws.waitFor((msg) => msg.roomStatus?.playStatus === "PAUSED")
        again.ws.send(JSON.stringify({
          operateType: "SET_PLAYER",
          "x-pt-local-id": "browser-a",
          "x-pt-stamp": stamp + 400,
          playStatus: "PAUSED",
          speedRate: "0.8",
          contentStamp: 1800,
        }))
        const msg = await paused
        assert.equal(msg.roomStatus.operator, a.body.data.guestId)
      } finally {
        again.ws.close()
      }
    } finally {
      other.ws.close()
    }
  })
})

test("someone who never entered cannot drive the socket", async () => {
  await withServer(async ({ wsUrl }) => {
    const ws = await openWs(wsUrl)
    try {
      await ws.waitFor((msg) => msg.responseType === "CONNECTED")
      const failed = ws.waitFor((msg) => msg.responseType === "ERROR")
      ws.send(JSON.stringify({
        operateType: "FIRST_SEND",
        "x-pt-local-id": "browser-c",
        "x-pt-stamp": Date.now(),
      }))
      const error = await failed
      assert.equal(error.code, "E4003")
      assert.equal(error.errMsg, "NOT_IN_SESSION")
      await new Promise((resolve) => ws.once("close", resolve))
    } finally {
      ws.close()
    }
  })
})

test("bad requests name a stable error and do not require a nickname", async () => {
  await withServer(async ({ base }) => {
    const missing = await post(base, "/room-operate", { operateType: "ENTER", nickName: "只有昵称" })
    assert.deepEqual(missing.body, { code: "E4000", errMsg: "BAD_LOCAL_ID" })
    const blank = await enter(base, "   ")
    assert.equal(blank.body.errMsg, "BAD_LOCAL_ID")
    const tooLong = await enter(base, "x".repeat(129))
    assert.equal(tooLong.body.errMsg, "BAD_LOCAL_ID")
    const max = await enter(base, "x".repeat(128))
    assert.equal(max.body.code, "0000")

    const badJson = await fetch(base + "/room-operate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    })
    assert.deepEqual(await badJson.json(), { code: "E4000", errMsg: "BAD_JSON" })

    const getRoom = await fetch(base + "/room-operate")
    assert.deepEqual(await getRoom.json(), { code: "E4005", errMsg: "METHOD_NOT_ALLOWED" })
    const unknown = await fetch(base + "/nope")
    assert.equal(unknown.status, 404)
    assert.deepEqual(await unknown.json(), { code: "E4004", errMsg: "NOT_FOUND" })

    const clock = await post(base, "/pt-service", { operate: "TIME" })
    assert.equal(clock.body.code, "0000")
    assert.equal(typeof clock.body.data.stamp, "number")
    assert.ok(Math.abs(clock.body.data.stamp - Date.now()) < 2000)

    const heartbeat = await post(base, "/room-operate", {
      operateType: "HEARTBEAT",
      "x-pt-local-id": "not-joined",
    })
    assert.equal(heartbeat.body.errMsg, "NOT_IN_SESSION")
    const leave = await post(base, "/room-operate", {
      operateType: "LEAVE",
      "x-pt-local-id": "not-joined",
    })
    assert.equal(leave.body.errMsg, "NOT_IN_SESSION")
  })
})

test("explicit leave frees a seat immediately and the episode stays until the process ends", async () => {
  await withServer(async ({ base }) => {
    await enter(base, "browser-a")
    await enter(base, "browser-b")
    await post(base, "/room-operate", {
      operateType: "SET_CONTENT",
      "x-pt-local-id": "browser-a",
      link: EPISODE_URL,
    })
    const left = await post(base, "/room-operate", {
      operateType: "LEAVE",
      "x-pt-local-id": "browser-a",
    })
    assert.deepEqual(left.body, { code: "0000" })
    const third = await enter(base, "browser-c")
    assert.equal(third.body.code, "0000")
    assert.equal(third.body.data.content.audioUrl, "https://media.xyzcdn.net/test-episode.m4a")
    assert.equal(third.body.data.participants.length, 2)

    const fresh = createApp({ fetchImpl: mockFetch })
    try {
      assert.equal(fresh.session.participantCount(), 0)
      assert.equal(fresh.session.hasContent(), false)
    } finally {
      await fresh.close()
    }
  })
})

test("restarting the process clears participants and episode state", async () => {
  const first = await startProcess()
  try {
    const a = await enter(first.base, "browser-a")
    const b = await enter(first.base, "browser-b")
    assert.equal(a.body.code, "0000")
    assert.equal(b.body.code, "0000")
    const blocked = await enter(first.base, "browser-c")
    assert.equal(blocked.body.errMsg, "SESSION_FULL")
    const health = await fetch(first.base + "/health").then((res) => res.json())
    assert.equal(health.participants, 2)
  } finally {
    await first.stop()
  }

  const second = await startProcess()
  try {
    const health = await fetch(second.base + "/health").then((res) => res.json())
    assert.equal(health.ok, true)
    assert.equal(health.participants, 0)
    assert.equal(health.hasContent, false)
    const rejoined = await enter(second.base, "browser-c")
    assert.equal(rejoined.body.code, "0000")
    assert.equal(rejoined.body.data.participants.length, 1)
    assert.equal(rejoined.body.data.content, null)
    const other = await enter(second.base, "browser-d")
    assert.equal(other.body.code, "0000")
    assert.equal(other.body.data.participants.length, 2)
  } finally {
    await second.stop()
  }
})

function startProcess() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["local-server/index.mjs"], {
      cwd: ROOT,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("server did not start\n" + out + "\n" + err))
    }, 8000)
    child.stdout.on("data", (chunk) => {
      out += chunk
      const match = out.match(/http:\/\/0\.0\.0\.0:(\d+)/)
      if (!match) return
      clearTimeout(timer)
      const port = match[1]
      resolve({
        base: `http://127.0.0.1:${port}`,
        stop: () => stopProcess(child),
      })
    })
    child.stderr.on("data", (chunk) => {
      err += chunk
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 2000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill("SIGTERM")
  })
}
