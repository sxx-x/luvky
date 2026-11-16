/**
 * One shared listening session.
 * Seat identity is the localStorage nonce sent as x-pt-local-id.
 * HTTP HEARTBEAT holds the seat. Mute and volume stay on this device.
 */
import { ref, reactive, onActivated, onDeactivated, nextTick } from "vue"
import { PageData, WsMsgRes, RoomStatus, PlayStatus, RevokeType } from "../../../type/type-room-page"
import { ContentData, RequestRes, RoRes } from "../../../type"
import ptUtil from "../../../utils/pt-util"
import util from "../../../utils/util"
import time from "../../../utils/time"
import playerTool from "./player-tool"
import cui from "../../../components/custom-ui"
import images from "../../../images"
import ptApi from "../../../utils/pt-api"
import { initPlayer } from "./init-player"
import { initWebSocket, sendToWebSocket, isWsOpen } from "./init-websocket"
import { request_enter, request_heartbeat, request_set_content, isSessionFull, SESSION_FULL_TEXT } from "./room-request"
import { bindMediaSession, clearMediaSession, enhanceAudioElement, seekPrecise, unlockAudioElement, updatePositionState } from "./media-session"

const COLLECT_TIMEOUT = 300
const RATES = ["0.8", "1", "1.2", "1.5", "1.7"] as const

let player: any
const playerEl = ref<HTMLElement | null>(null)
let playStatus: PlayStatus = "PAUSED"
let ws: WebSocket | null = null

const pageData: PageData = reactive({
  state: 3,
  roomId: "",
  content: null,
  participants: [],
  showMoreBox: false,
  amIOwner: false,
  everyoneCanOperatePlayer: "Y",
  showSyncGate: false,
  parsing: false,
  notice: "",
})

let localId = ""
let guestId = ""
let intervalHb = 0
let timeoutCollect = 0
let srcDuration = 0
let waitPlayer: Promise<boolean> = Promise.resolve(false)
let latestStatus: RoomStatus | undefined
let isShowingAutoPlayPolicy = false
let audioUnlocked = false
let wsManualClose = false
let wsRetryCount = 0
let wsReconnectTimer = 0
let wsCheckToken = 0
let lifecycleBound = false
let recovering = false
let entering = false
let enterRetryTimer = 0
let playAfterLoad = false
let wsJoined = false
let pendingPlay = false
let playerReadySettled = false
let playerGen = 0

let lastOperateLocalStamp = 0
let lastNewStatusFromWsStamp = 0
let lastHeartbeatStamp = 0
let lastReConnectWs = 0

let isRemoteSetSeek = false
let isRemoteSetPlaying = false
let isRemoteSetPaused = false
let isRemoteSetSpeedRate = false

type SimpleFunc = (ok: boolean) => void
let playerAlready: SimpleFunc = () => {}

function inWeChat(): boolean {
  return ptApi.getCharacteristic().isWeChat
}

function ensureLocalId() {
  const data = ptUtil.getUserData()
  localId = (data.nonce || "").trim()
}

function canOperatePlayer(): boolean {
  return true
}

function currentAudioTime(): number {
  const t = player?.audio?.currentTime
  if (typeof t === "number" && Number.isFinite(t)) return t
  return player?.currentTime ?? 0
}

function normalizeRate(value: unknown): RoomStatus["speedRate"] {
  const n = Number(value)
  const hit = RATES.find((rate) => Math.abs(Number(rate) - n) < 0.05)
  return hit || "1"
}

function statusFrom(ro: Partial<RoRes>, override?: Partial<RoomStatus>): RoomStatus {
  return {
    playStatus: override?.playStatus || ro.playStatus || "PAUSED",
    speedRate: normalizeRate(override?.speedRate || ro.speedRate || "1"),
    operator: override?.operator ?? ro.operator ?? "",
    contentStamp: override?.contentStamp ?? ro.contentStamp ?? 0,
    operateStamp: override?.operateStamp ?? ro.operateStamp ?? time.getTime(),
  }
}

export const useRoomPage = () => {
  init()
  return { pageData, playerEl, submitEpisode, onTapSyncGate }
}

function init() {
  onActivated(() => {
    bindLifecycle()
    if (inWeChat()) return
    void enterRoom()
  })
  onDeactivated(() => {
    // Dropping the socket does not free the seat. Do not send LEAVE.
    quietStop()
  })
}

function bindLifecycle() {
  if (lifecycleBound) return
  lifecycleBound = true
  document.addEventListener("visibilitychange", onVisibilityChange)
  window.addEventListener("pageshow", onPageShow)
  window.addEventListener("online", onOnline)
  window.addEventListener("focus", onWindowFocus)
}

function unbindLifecycle() {
  if (!lifecycleBound) return
  lifecycleBound = false
  document.removeEventListener("visibilitychange", onVisibilityChange)
  window.removeEventListener("pageshow", onPageShow)
  window.removeEventListener("online", onOnline)
  window.removeEventListener("focus", onWindowFocus)
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") void onForeground()
}
function onPageShow() { void onForeground() }
function onOnline() { void onForeground() }
function onWindowFocus() {
  if (document.visibilityState === "visible") void onForeground()
}

async function onForeground() {
  if (inWeChat() || document.visibilityState === "hidden") return
  await time.calibrateTime()
  if (pageData.state === 15) {
    void enterRoom({ soft: true })
    return
  }
  await silentRecover()
}

function clearEnterRetry() {
  if (enterRetryTimer) {
    clearTimeout(enterRetryTimer)
    enterRetryTimer = 0
  }
}

function scheduleEnterRetry() {
  if (enterRetryTimer) return
  const delay = pageData.state === 15 ? 8000 : 3000
  enterRetryTimer = window.setTimeout(() => {
    enterRetryTimer = 0
    void enterRoom({ soft: true })
  }, delay)
}

export async function enterRoom(opts?: { soft?: boolean }) {
  if (inWeChat() || entering) return
  entering = true
  const soft = !!opts?.soft
  try {
    ensureLocalId()
    if (!localId) return
    if (!soft) {
      pageData.showSyncGate = false
      audioUnlocked = false
      wsRetryCount = 0
    }
    wsManualClose = false
    const res = await request_enter()
    handleEnterResult(res, soft)
  } finally {
    entering = false
  }
}

function handleEnterResult(res: RequestRes<RoRes> | undefined, soft: boolean) {
  if (isSessionFull(res)) {
    markFull(res)
    return
  }
  if (!res || res.code !== "0000" || !res.data) {
    if (pageData.state !== 15) pageData.state = 3
    scheduleEnterRetry()
    return
  }
  clearEnterRetry()
  pageData.state = 3
  pageData.notice = ""
  if (!soft) pageData.showSyncGate = false
  applySnapshot(res.data, false)
  if (!intervalHb) heartbeat()
  if (!isWsOpen(ws)) connectWebSocket()
  else firstSend()
}

function markFull(res?: { showMsg?: string } | null) {
  pageData.state = 15
  pageData.notice = res?.showMsg || SESSION_FULL_TEXT
  pageData.showSyncGate = false
  pageData.parsing = false
  playAfterLoad = false
  quietStop()
  scheduleEnterRetry()
}

function quietStop() {
  wsManualClose = true
  clearEnterRetry()
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = 0
  }
  wsCheckToken++
  if (intervalHb) {
    clearInterval(intervalHb)
    intervalHb = 0
  }
  if (ws) {
    try {
      ws.onclose = null
      ws.close()
    } catch { /* already closed */ }
    ws = null
  }
  destroyPlayerInstance()
}

function applySnapshot(data: RoRes, fromPaste: boolean) {
  if (data.guestId) guestId = data.guestId
  const status = statusFrom(data)
  if (fromPaste) {
    playAfterLoad = true
    applyIncomingContent(data.content, {
      ...status,
      playStatus: "PLAYING",
      contentStamp: 0,
      speedRate: "1",
      operateStamp: time.getTime(),
    }, true)
    return
  }
  applyIncomingContent(data.content, status, false)
}

function applyIncomingContent(content: ContentData | null | undefined, status: RoomStatus | undefined, fromPaste: boolean) {
  const previous = latestStatus
  if (status) latestStatus = status
  if ((fromPaste || playAfterLoad) && latestStatus) {
    latestStatus = {
      ...latestStatus,
      playStatus: "PLAYING",
      contentStamp: 0,
      speedRate: "1",
    }
  }
  if (!content?.audioUrl) {
    // A restart, or a FIRST_SEND that raced ahead of SET_CONTENT.
    if (playAfterLoad || pageData.parsing || (pageData.content?.audioUrl && status && previous && status.operateStamp < previous.operateStamp)) {
      if (previous) latestStatus = previous
      return
    }
    clearEpisode()
    return
  }
  const changed = pageData.content?.audioUrl !== content.audioUrl
  pageData.content = content
  if (pageData.state !== 15) pageData.state = 3
  const afterReady = () => {
    void finishApply(fromPaste)
  }
  if (changed || !player) rebuildPlayer(afterReady)
  else afterReady()
}

async function finishApply(fromPaste: boolean) {
  if (!fromPaste && !playAfterLoad) {
    const now = time.getLocalTime()
    if (now - lastOperateLocalStamp < 900) return
    if (now - lastNewStatusFromWsStamp < 900) return
  }
  await receiveNewStatus(fromPaste ? "http" : "http")
  if (!(fromPaste || playAfterLoad)) return
  publishStart()
  if (isAppleMobile() && !audioUnlocked) {
    pageData.showSyncGate = true
    return
  }
  playAfterLoad = false
  if (playStatus !== "PLAYING" && player) {
    isRemoteSetPlaying = true
    isRemoteSetSeek = true
    seekPrecise(player, 0)
    try {
      const ret = player.play()
      if (ret && typeof ret.catch === "function") {
        ret.catch(() => { pageData.showSyncGate = true })
      }
    } catch {
      pageData.showSyncGate = true
    }
  }
}

function clearEpisode() {
  pageData.content = null
  playAfterLoad = false
  destroyPlayerInstance()
}

function rebuildPlayer(done?: () => void) {
  destroyPlayerInstance()
  nextTick(() => {
    if (pageData.state === 15) return
    if (!pageData.content?.audioUrl || !playerEl.value) return
    createPlayer()
    done && done()
  })
}

function destroyPlayerInstance() {
  clearMediaSession()
  if (player) {
    try { player.destroy() } catch (err) { console.log(err) }
    player = null
  }
  srcDuration = 0
  playerReadySettled = false
  if (playerEl.value) playerEl.value.replaceChildren()
}

export async function submitEpisode(link: string) {
  if (pageData.state === 15 || pageData.parsing) return
  ensureLocalId()
  pageData.parsing = true
  playAfterLoad = true
  try {
    let res = await request_set_content(link)
    if (res?.code === "E4003" || res?.errMsg === "NOT_IN_SESSION") {
      const entered = await request_enter()
      if (isSessionFull(entered)) {
        markFull(entered)
        return
      }
      if (entered?.code === "0000") {
        handleEnterResult(entered, true)
        res = await request_set_content(link)
      }
    }
    if (isSessionFull(res)) {
      markFull(res)
      return
    }
    if (!res || res.code !== "0000" || !res.data?.content?.audioUrl) {
      playAfterLoad = false
      await cui.showModal({
        title: "请粘贴小宇宙单集链接",
        content: res?.showMsg || "没有解析到这集的音频",
        showCancel: false,
      })
      return
    }
    applySnapshot(res.data, true)
  } finally {
    pageData.parsing = false
  }
}

function publishStart() {
  if (!localId || !pageData.content?.audioUrl) return
  pendingPlay = true
  playStatus = "PLAYING"
  flushPendingPlay()
}

function flushPendingPlay() {
  if (!pendingPlay || !wsJoined || !isWsOpen(ws) || !localId) return
  pendingPlay = false
  sendToWebSocket(ws, {
    operateType: "SET_PLAYER",
    "x-pt-local-id": localId,
    "x-pt-stamp": time.getTime(),
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 0,
  })
}

function createPlayer() {
  const content = pageData.content
  if (!content?.audioUrl) return

  if (!playerReadySettled) playerAlready(true)
  playerGen += 1
  const gen = playerGen
  playerReadySettled = false
  waitPlayer = new Promise((resolve) => {
    playerAlready = resolve
  })

  const durationchange = (duration?: number) => {
    if (gen !== playerGen) return
    if (duration) srcDuration = duration
    showPage()
  }
  const pause = () => {
    playStatus = "PAUSED"
    if (isRemoteSetPaused) {
      isRemoteSetPaused = false
      return
    }
    if (document.visibilityState === "hidden") return
    collectLatestStatus()
  }
  const playing = () => {
    playStatus = "PLAYING"
    if (isRemoteSetPlaying) {
      isRemoteSetPlaying = false
      return
    }
    collectLatestStatus()
  }
  const ratechange = () => {
    if (isRemoteSetSpeedRate) {
      isRemoteSetSpeedRate = false
      return
    }
    collectLatestStatus()
  }
  const seeked = () => {
    if (isRemoteSetSeek) {
      isRemoteSetSeek = false
      return
    }
    collectLatestStatus()
  }

  player = initPlayer(
    playerEl,
    {
      src: content.audioUrl,
      title: content.title,
      cover: content.imageUrl || images.APP_LOGO,
      artist: content.seriesName,
    },
    { durationchange, pause, playing, ratechange, seeked },
    () => true,
  )
  enhanceAudioElement(player, playerEl.value)
  bindMediaSession({
    getPlayer: () => player,
    getPageData: () => pageData,
    getLatestStatus: () => latestStatus,
    getPlayStatus: () => playStatus,
    canOperatePlayer,
  }, content)
  if (isAppleMobile() && !audioUnlocked && (playAfterLoad || latestStatus?.playStatus === "PLAYING")) {
    pageData.showSyncGate = true
  }
  void checkPlayerReady()
}

function isAppleMobile(): boolean {
  const cha = ptApi.getCharacteristic()
  return !!(cha.isIOS || cha.isIPadOS)
}

async function checkPlayerReady() {
  if (!isAppleMobile()) {
    void checkPlayerReadyAgain(6000)
    return
  }
  await util.waitMilli(800)
  showPage()
  void checkPlayerReadyAgain(12000)
}

async function checkPlayerReadyAgain(waitMs = 6000) {
  await util.waitMilli(waitMs)
  showPage()
}

function showPage(): void {
  if (pageData.state === 15) return
  if (pageData.state < 3) pageData.state = 3
  if (!playerReadySettled) {
    playerReadySettled = true
    playerAlready(true)
  }
}

async function onTapSyncGate() {
  if (!player) return
  audioUnlocked = true
  pageData.showSyncGate = false
  const wantPlay = playAfterLoad || latestStatus?.playStatus === "PLAYING"
  await unlockAudioElement(player)
  if (srcDuration && latestStatus) await receiveNewStatus("check")
  if (wantPlay && playStatus !== "PLAYING") {
    isRemoteSetPlaying = true
    try { await player.play() } catch { /* the button can be tapped again */ }
  }
  if (playAfterLoad) {
    playAfterLoad = false
    publishStart()
  }
  updatePositionState()
}

function collectLatestStatus() {
  lastOperateLocalStamp = time.getLocalTime()
  if (timeoutCollect) clearTimeout(timeoutCollect)
  timeoutCollect = window.setTimeout(() => {
    if (!player || !localId || !pageData.content?.audioUrl) return
    if (document.visibilityState === "hidden") return
    const contentStamp = util.numToFix(currentAudioTime() * 1000, 0)
    sendToWebSocket(ws, {
      operateType: "SET_PLAYER",
      "x-pt-local-id": localId,
      "x-pt-stamp": time.getTime(),
      playStatus,
      speedRate: normalizeRate(player.playbackRate),
      contentStamp,
    })
    void checkOperated()
  }, COLLECT_TIMEOUT)
}

async function checkOperated() {
  await util.waitMilli(2500)
  if (time.getLocalTime() - lastNewStatusFromWsStamp < 3000) return
  connectWebSocket()
}

function heartbeat() {
  const period = util.getEnv().HEARTBEAT_PERIOD || 15
  lastHeartbeatStamp = 0
  if (intervalHb) clearInterval(intervalHb)
  intervalHb = window.setInterval(async () => {
    const now = time.getLocalTime()
    if (lastHeartbeatStamp > 0 && lastHeartbeatStamp + 35000 < now) {
      void silentRecover()
      return
    }
    lastHeartbeatStamp = now
    const res = await request_heartbeat()
    if (!res) return
    if (isSessionFull(res)) {
      markFull(res)
      return
    }
    if (res.code === "0000" && res.data) {
      applySnapshot(res.data, false)
      sendToWebSocket(ws, {
        operateType: "HEARTBEAT",
        "x-pt-local-id": localId,
        "x-pt-stamp": time.getTime(),
      })
      return
    }
    if (res.code === "E4003" || res.errMsg === "NOT_IN_SESSION") {
      void enterRoom({ soft: true })
      return
    }
    void silentRecover()
  }, period * 1000)
}

async function silentRecover() {
  if (recovering || inWeChat() || pageData.state === 15) return
  recovering = true
  try {
    await time.calibrateTime()
    wsManualClose = false
    ensureLocalId()
    let res = guestId ? await request_heartbeat() : undefined
    if (!guestId || !res || res.code === "E4003" || res.errMsg === "NOT_IN_SESSION") {
      res = await request_enter()
    }
    if (isSessionFull(res)) {
      markFull(res)
      return
    }
    if (!res || res.code !== "0000" || !res.data) {
      scheduleEnterRetry()
      return
    }
    if (res.data.guestId) guestId = res.data.guestId
    pageData.state = 3
    applySnapshot(res.data, false)
    if (!intervalHb) heartbeat()
    if (!isWsOpen(ws)) connectWebSocket()
    lastHeartbeatStamp = time.getLocalTime()
  } finally {
    recovering = false
  }
}

function scheduleWsReconnect() {
  if (wsManualClose || pageData.state === 15) return
  const now = time.getLocalTime()
  if (lastReConnectWs + 800 > now) return
  lastReConnectWs = now
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
  const delay = Math.min(1000 * (2 ** Math.min(wsRetryCount, 3)), 8000)
  wsRetryCount++
  wsReconnectTimer = window.setTimeout(() => {
    connectWebSocket()
  }, delay)
}

function connectWebSocket() {
  if (wsManualClose || !localId) return
  wsJoined = false
  const myToken = ++wsCheckToken
  if (ws) {
    try {
      ws.onclose = null
      ws.onmessage = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    } catch { /* ignore */ }
    ws = null
  }

  const onmessage = (msg: WsMsgRes) => {
    if (msg.responseType === "CONNECTED") {
      firstSend()
      return
    }
    if (msg.responseType === "ERROR") {
      if (isSessionFull(msg)) {
        markFull(msg)
        return
      }
      if (msg.errMsg === "NOT_IN_SESSION" || msg.code === "E4003") {
        guestId = ""
        void enterRoom({ soft: true })
        return
      }
      scheduleWsReconnect()
      return
    }
    if (msg.responseType === "HEARTBEAT") return
    if (msg.responseType === "NEW_CONTENT" || (msg.responseType === "NEW_STATUS" && msg.content !== undefined)) {
      wsJoined = true
      if (msg.roomStatus) lastNewStatusFromWsStamp = time.getLocalTime()
      applyIncomingContent(msg.content ?? null, msg.roomStatus, false)
      flushPendingPlay()
      return
    }
    if (msg.responseType === "NEW_STATUS" && msg.roomStatus) {
      wsJoined = true
      lastNewStatusFromWsStamp = time.getLocalTime()
      latestStatus = msg.roomStatus
      if (msg.roomStatus.playStatus === "PLAYING") playAfterLoad = false
      void receiveNewStatus()
      flushPendingPlay()
    }
  }

  ws = initWebSocket({
    onmessage,
    onopen: () => { wsRetryCount = 0 },
    onclose: (ev) => {
      if (wsManualClose || pageData.state === 15) return
      if (ev.code === 4003) {
        guestId = ""
        void enterRoom({ soft: true })
        return
      }
      scheduleWsReconnect()
    },
  })
  void checkWebSocket(myToken)
}

async function checkWebSocket(token: number) {
  await util.waitMilli(5000)
  if (token !== wsCheckToken || wsManualClose || pageData.state === 15) return
  if (!isWsOpen(ws)) scheduleWsReconnect()
}

function firstSend() {
  sendToWebSocket(ws, {
    operateType: "FIRST_SEND",
    "x-pt-local-id": localId,
    "x-pt-stamp": time.getTime(),
  })
}

async function receiveNewStatus(fromType: RevokeType = "ws") {
  if (!latestStatus) return
  const gen = playerGen
  const ready = waitPlayer
  await ready
  if (gen !== playerGen || !player) return
  if (!srcDuration) return

  const { contentStamp } = latestStatus
  const reSeekSec = playerTool.getReSeek(latestStatus, srcDuration, currentAudioTime(), fromType)
  if (reSeekSec >= 0) {
    isRemoteSetSeek = true
    seekPrecise(player, reSeekSec)
    void checkSeek()
  }

  const remoteRate = normalizeRate(latestStatus.speedRate)
  if (remoteRate !== normalizeRate(player.playbackRate)) {
    isRemoteSetSpeedRate = true
    player.playbackRate = Number(remoteRate)
  }

  const remotePlay = latestStatus.playStatus
  const remain = (srcDuration * 1000) - contentStamp
  if (remotePlay !== playStatus) {
    if (remotePlay === "PLAYING" && remain < 1000) return
    if (remotePlay === "PLAYING" && !isShowingAutoPlayPolicy) {
      if (!audioUnlocked && isAppleMobile()) {
        pageData.showSyncGate = true
        return
      }
      isRemoteSetPlaying = true
      try {
        const ret = player.play()
        if (ret && typeof ret.catch === "function") ret.catch(() => handleAutoPlayPolicy())
      } catch {
        handleAutoPlayPolicy()
      }
      void checkIsPlaying()
    } else if (remotePlay === "PAUSED") {
      isRemoteSetPaused = true
      player.pause()
    }
  }
  updatePositionState()
}

async function checkSeek() {
  await util.waitMilli(600)
  if (!latestStatus || !player || !srcDuration) return
  const reSeekSec = playerTool.getReSeek(latestStatus, srcDuration, currentAudioTime(), "check")
  if (reSeekSec >= 0) {
    isRemoteSetSeek = true
    seekPrecise(player, reSeekSec)
  }
}

async function checkIsPlaying() {
  await util.waitMilli(1500)
  if (!latestStatus) return
  if (latestStatus.playStatus === "PLAYING" && playStatus === "PAUSED") handleAutoPlayPolicy()
}

async function handleAutoPlayPolicy() {
  if (isShowingAutoPlayPolicy || pageData.showSyncGate) return
  if (!audioUnlocked) {
    pageData.showSyncGate = true
    return
  }
  isShowingAutoPlayPolicy = true
  const choice = await cui.showModal({
    title: "点击后才能播放",
    content: "要不要出声？",
    cancelText: "静音",
    confirmText: "开声音",
  })
  isShowingAutoPlayPolicy = false
  if (!player || !latestStatus) return
  if (choice.cancel) player.muted = true
  if (srcDuration) {
    const reSeekSec = playerTool.getReSeek(latestStatus, srcDuration, currentAudioTime(), "check")
    if (reSeekSec >= 0) {
      isRemoteSetSeek = true
      seekPrecise(player, reSeekSec)
    }
  }
  if (latestStatus.playStatus === "PLAYING") {
    isRemoteSetPlaying = true
    player.play()
  }
}
