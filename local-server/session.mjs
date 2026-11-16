/**
 * 全站只有一个一起听会话，数据只放在这个进程的内存里。
 * 进程退出或重新部署后会话消失，不落盘，也没有链接过期计时器。
 *
 * 播放进度不靠持续推流。contentStamp 是 operateStamp 那一刻的位置（毫秒）。
 * PLAYING 时另一端用校准后的服务器时间外推：
 *   contentStamp + (now - operateStamp) * Number(speedRate)
 * PAUSED 时位置就是 contentStamp。音量和静音不属于这份状态。
 *
 * 同一个人以 x-pt-local-id 识别。刷新或换一条 WebSocket 仍是同一个名额。
 * 断线不会立刻腾出名额；名额只在显式 LEAVE，或超过 PRESENCE_TTL_MS 没有
 * HTTP 心跳时释放。WebSocket 心跳不刷新名额。
 */

export const MAX_PARTICIPANTS = 2
export const PRESENCE_TTL_MS = 60_000
export const PLAYING_SWEEP_MS = 30_000
export const MIN_OPERATE_GAP_MS = 250
export const SPEED_RATES = Object.freeze(["0.8", "1", "1.2", "1.5", "1.7"])
const SPEED_RATE_SET = new Set(SPEED_RATES)

const GUEST_ALPHABET = "abcdefghijkmnopqrstuvwyz123456789"

export function normalizeClientId(value) {
  if (typeof value !== "string") return ""
  const id = value.trim()
  if (!id || id.length > 128) return ""
  return id
}

function clip(value, max) {
  if (typeof value !== "string") return ""
  const text = value.trim()
  if (text.length <= max) return text
  return text.slice(0, max)
}

function emptyContent() {
  return null
}

function copyContent(content) {
  if (!content) return emptyContent()
  return {
    infoType: "podcast",
    audioUrl: content.audioUrl,
    sourceType: "xiaoyuzhou",
    title: content.title,
    description: content.description,
    imageUrl: content.imageUrl,
    linkUrl: content.linkUrl,
    seriesName: content.seriesName,
    seriesUrl: content.seriesUrl,
  }
}

function isEpisodeContent(content) {
  if (!content || content.infoType !== "podcast") return false
  if (content.sourceType !== "xiaoyuzhou") return false
  if (typeof content.audioUrl !== "string" || !content.audioUrl.startsWith("https://")) return false
  if (content.audioUrl.length > 2000) return false
  return true
}

function normalizeEpisode(content) {
  return {
    infoType: "podcast",
    audioUrl: content.audioUrl,
    sourceType: "xiaoyuzhou",
    title: clip(content.title, 300),
    description: clip(content.description, 4000),
    imageUrl: clip(content.imageUrl, 1000),
    linkUrl: clip(content.linkUrl, 500),
    seriesName: clip(content.seriesName, 300),
    seriesUrl: clip(content.seriesUrl, 500),
  }
}

function generateGuestId(participants) {
  const used = new Set(participants.map((item) => item.guestId))
  for (let attempt = 0; attempt < 20; attempt++) {
    let guestId = ""
    for (let i = 0; i < 11; i++) {
      guestId += GUEST_ALPHABET[Math.floor(Math.random() * GUEST_ALPHABET.length)]
    }
    if (!used.has(guestId)) return guestId
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function playbackRate(speedRate) {
  const rate = Number(speedRate)
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 1.71) return 1
  return rate
}

export function createSession(nowFn = Date.now) {
  const now = () => nowFn()

  let content = emptyContent()
  let playStatus = "PAUSED"
  let speedRate = "1"
  let contentStamp = 0
  let operateStamp = now()
  let operator = ""
  /** @type {{ clientId: string, guestId: string, enterStamp: number, heartbeatStamp: number }[]} */
  let participants = []

  function roomStatus() {
    return {
      playStatus,
      speedRate,
      operator,
      contentStamp,
      operateStamp,
    }
  }

  function view(guestId) {
    return {
      content: copyContent(content),
      ...roomStatus(),
      participants: participants.map((item) => ({
        guestId: item.guestId,
        heartbeatStamp: item.heartbeatStamp,
        enterStamp: item.enterStamp,
      })),
      guestId,
    }
  }

  function find(clientId) {
    return participants.find((item) => item.clientId === clientId)
  }

  function prune(stamp, keepClientId) {
    participants = participants.filter((item) => {
      return item.clientId === keepClientId || stamp - item.heartbeatStamp < PRESENCE_TTL_MS
    })
  }

  function pauseAt(stamp, nextOperator) {
    if (playStatus !== "PLAYING") {
      operator = nextOperator
      return
    }
    let lastHeartbeat = operateStamp
    for (const item of participants) {
      if (item.heartbeatStamp > lastHeartbeat) lastHeartbeat = item.heartbeatStamp
    }
    contentStamp = contentStamp + (lastHeartbeat - operateStamp) * playbackRate(speedRate)
    playStatus = "PAUSED"
    operateStamp = stamp
    operator = nextOperator
  }

  function enter(clientId) {
    const stamp = now()
    const existing = find(clientId)
    if (existing) {
      existing.enterStamp = stamp
      existing.heartbeatStamp = stamp
      prune(stamp, clientId)
      return { code: "0000", data: view(existing.guestId) }
    }

    prune(stamp, "")
    if (participants.length >= MAX_PARTICIPANTS) {
      return {
        code: "R0001",
        errMsg: "SESSION_FULL",
        showMsg: "已经有两个人在一起听了",
      }
    }

    const guestId = generateGuestId(participants)
    participants.push({
      clientId,
      guestId,
      enterStamp: stamp,
      heartbeatStamp: stamp,
    })
    return { code: "0000", data: view(guestId) }
  }

  function heartbeat(clientId) {
    const me = find(clientId)
    if (!me) {
      return {
        code: "E4003",
        errMsg: "NOT_IN_SESSION",
        showMsg: "请先加入一起听",
      }
    }
    const stamp = now()
    me.heartbeatStamp = stamp
    prune(stamp, clientId)
    return { code: "0000", data: view(me.guestId) }
  }

  function leave(clientId) {
    const me = find(clientId)
    if (!me) {
      return {
        code: "E4003",
        errMsg: "NOT_IN_SESSION",
        showMsg: "请先加入一起听",
      }
    }
    if (participants.length === 1) {
      pauseAt(now(), "")
      participants = []
      return { code: "0000" }
    }
    participants = participants.filter((item) => item.clientId !== clientId)
    return { code: "0000" }
  }

  function setContent(clientId, nextContent) {
    const me = find(clientId)
    if (!me) {
      return {
        code: "E4003",
        errMsg: "NOT_IN_SESSION",
        showMsg: "请先加入一起听",
      }
    }
    if (!isEpisodeContent(nextContent)) {
      return {
        code: "E4000",
        errMsg: "XIAOYUZHOU_EPISODE_ONLY",
        showMsg: "只能粘贴小宇宙单集链接",
      }
    }
    const stamp = now()
    content = normalizeEpisode(nextContent)
    playStatus = "PAUSED"
    speedRate = "1"
    contentStamp = 0
    operateStamp = stamp
    operator = ""
    me.heartbeatStamp = stamp
    return { code: "0000", data: view(me.guestId) }
  }

  function setPlayer(clientId, stamp, command) {
    const me = find(clientId)
    if (!me) {
      return {
        code: "E4003",
        errMsg: "NOT_IN_SESSION",
        showMsg: "请先加入一起听",
      }
    }
    const play = command?.playStatus
    if (play !== "PLAYING" && play !== "PAUSED") return { ignore: "BAD_PLAYER" }
    const rate = String(command.speedRate)
    if (!SPEED_RATE_SET.has(rate)) return { ignore: "BAD_SPEED" }
    const position = command.contentStamp
    if (typeof position !== "number" || !Number.isFinite(position) || position < 0) {
      return { ignore: "BAD_POSITION" }
    }
    if (!content) return { ignore: "NO_CONTENT" }
    if (typeof stamp !== "number" || !Number.isFinite(stamp)) return { ignore: "BAD_STAMP" }
    if (me.guestId === operator && stamp - operateStamp < MIN_OPERATE_GAP_MS) {
      return { ignore: "TOO_SOON" }
    }

    playStatus = play
    speedRate = rate
    contentStamp = position
    operateStamp = stamp
    operator = me.guestId
    return { code: "0000", roomStatus: roomStatus() }
  }

  function snapshotFor(clientId) {
    const me = find(clientId)
    if (!me) return null
    return {
      guestId: me.guestId,
      content: copyContent(content),
      roomStatus: roomStatus(),
    }
  }

  function cleanupPlaying() {
    if (playStatus !== "PLAYING") return []
    const stamp = now()
    const oldLength = participants.length
    if (oldLength < 1) {
      playStatus = "PAUSED"
      operator = ""
      return []
    }

    let lastHeartbeat = 1
    const alive = []
    const removed = []
    for (const item of participants) {
      if (item.heartbeatStamp > lastHeartbeat) lastHeartbeat = item.heartbeatStamp
      if (item.heartbeatStamp > stamp - PRESENCE_TTL_MS) alive.push(item)
      else removed.push(item.clientId)
    }
    if (alive.length === oldLength) return []
    participants = alive
    if (alive.length === 0) {
      contentStamp = contentStamp + (lastHeartbeat - operateStamp) * playbackRate(speedRate)
      playStatus = "PAUSED"
      operateStamp = stamp
      operator = ""
    }
    return removed
  }

  function participantCount() {
    return participants.length
  }

  function hasContent() {
    return content !== null
  }

  return {
    enter,
    heartbeat,
    leave,
    setContent,
    setPlayer,
    snapshotFor,
    cleanupPlaying,
    participantCount,
    hasContent,
    roomStatus,
  }
}
