/**
 * @file 房间处理主逻辑
 * @author yenche123 <tsuiyenche@outlook.com>
 * @copyright TSUI YEN-CHE 2022
 */
import { ref, reactive, onActivated, onDeactivated, nextTick } from "vue"
import { PageData, PageState, WsMsgRes, RoomStatus, PlayStatus, RevokeType } from "../../../type/type-room-page"
import { ContentData, RequestRes, RoRes } from "../../../type"
import { RouteLocationNormalizedLoaded } from "vue-router"
import { useRouteAndPtRouter, PtRouter, goHome } from "../../../routes/pt-router"
import ptUtil from "../../../utils/pt-util"
import util from "../../../utils/util"
import time from "../../../utils/time"
import playerTool from "./player-tool"
import { showParticipants, handleShowMoreBox } from "./show-room"
import cui from "../../../components/custom-ui"
import images from "../../../images"
import ptApi from "../../../utils/pt-api"
import { initPlayer } from "./init-player"
import { initWebSocket, sendToWebSocket, isWsOpen } from "./init-websocket"
import { shareData } from "./init-share"
import { request_enter, request_heartbeat, request_leave } from "./room-request"
import { bindMediaSession, clearMediaSession, enhanceAudioElement, seekPrecise, unlockAudioElement, updatePositionState } from "./media-session"

// 一些常量
const COLLECT_TIMEOUT = 300    // 收集最新状态的最小间隔
const MAX_HB_NUM = 960    // 心跳最多轮询次数；如果每 15s 一次，相当于 4hr

// 播放器
let player: any;
const playerEl = ref<HTMLElement | null>(null)
let playStatus: PlayStatus = "PAUSED"    // 播放状态

// 路由
let router: PtRouter
let route: RouteLocationNormalizedLoaded

// web socket
let ws: WebSocket | null = null

// 绑定到页面的数据
const pageData: PageData = reactive({
  state: 1,
  roomId: "",
  participants: [],
  showMoreBox: false,   // 是否要展示 “展开更多” 的按钮
  amIOwner: false,
  everyoneCanOperatePlayer: "Y",
  showSyncGate: false,
})

// 其他杂七杂八的数据
let nickName: string = ""
let localId: string = ""
let guestId: string = ""
let intervalHb: number = 0      // 维持心跳的 interval 的返回值
let timeoutCollect: number = 0  // 上报最新播放状态的 timeout 的返回值
let srcDuration: number = 0     // 资源总时长（秒），如果为 0 代表还没解析出来
let waitPlayer: Promise<boolean>
let latestStatus: RoomStatus    // 最新的播放器状态
let isShowingAutoPlayPolicy: boolean = false  // 当前是否已在展示 autoplay policy 的弹窗
let heartbeatNum = 0            // 心跳的次数
let receiveWsNum = 0            // 收到 web-socket 的次数
let pausedSec = 0               // 已经暂停的秒数
let audioUnlocked = false       // 是否已用用户手势解锁过音频
let wsManualClose = false       // 是否为离开房间时主动关闭
let wsRetryCount = 0
let wsReconnectTimer = 0
let wsCheckToken = 0            // 用来作废过期的连接检查
let lifecycleBound = false
let recovering = false          // 避免恢复流程重入

// 时间戳
let lastOperateLocalStamp = 0        // 上一个本地设置远端服务器的时间戳
let lastNewStatusFromWsStamp = 0    // 上一次收到 web-socket NEW_STATUS 的时间戳
let lastHeartbeatStamp = 0          // 上一次心跳的时间戳
let lastReConnectWs = 0

// 是否为远端调整播放器状态，如果是，则在监听 player 各回调时不往下执行
let isRemoteSetSeek = false
let isRemoteSetPlaying = false
let isRemoteSetPaused = false
let isRemoteSetSpeedRate = false

// 播放器准备好的回调
type SimpleFunc = (param1: boolean) => void
let playerAlready: SimpleFunc


const toHome = () => {
  goHome(router)
}

const toContact = () => {
  router.push({ name: "contact" })
}

// 本地修改我的昵称，再上报远端
const toEditMyName = async (newName: string) => {
  if(pageData.state !== 3) return
  const participants = pageData.participants
  // 修改视图
  for(let i=0; i<participants?.length; i++) {
    const v = participants[i]
    if(v.isMe) v.nickName = newName
  }
  nickName = newName
  // 上报远端
  // 销毁心跳、再用新的心跳上报
  await request_heartbeat(pageData.roomId, nickName)

  // 修改缓存
  let userData = ptUtil.getUserData()
  userData.nickName = newName
  ptUtil.setUserData(userData)
}

const onEveryoneCanOperatePlayerChange = (opt: { checked: boolean }) => {
  if(!pageData.amIOwner) return
  pageData.everyoneCanOperatePlayer = opt.checked ? "Y" : "N"
  collectLatestStatus()
}

export const useRoomPage = () => {
  const rr = useRouteAndPtRouter()
  router = rr.router
  route = rr.route
  
  init()

  return { 
    pageData, 
    playerEl, 
    route, 
    router, 
    toHome, 
    toContact, 
    toEditMyName,
    onEveryoneCanOperatePlayerChange,
    onTapSyncGate,
  }
}

// 初始化一些东西，比如 onActivated / onDeactivated 
function init() {
  onActivated(() => {
    bindLifecycle()
    enterRoom()
  })

  onDeactivated(() => {
    leaveRoom()
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
  if (document.visibilityState === "visible") {
    onForeground("visibilitychange")
  }
}

function onPageShow(ev: PageTransitionEvent) {
  onForeground(ev.persisted ? "pageshow-bfcache" : "pageshow")
}

function onOnline() {
  onForeground("online")
}

function onWindowFocus() {
  if (document.visibilityState === "visible") onForeground("focus")
}

async function onForeground(reason: string) {
  if (pageData.state !== 2 && pageData.state !== 3) return
  if (document.visibilityState === "hidden") return
  console.log("foreground recover:", reason)
  await time.calibrateTime()
  await silentRecover()
}

function canOperatePlayer(): boolean {
  return pageData.amIOwner || pageData.everyoneCanOperatePlayer !== "N"
}

function currentAudioTime(): number {
  const t = player?.audio?.currentTime
  if (typeof t === "number" && Number.isFinite(t)) return t
  return player?.currentTime ?? 0
}


// 进入房间
export async function enterRoom() {
  let roomId: string = route.params.roomId as string
  pageData.roomId = roomId
  pageData.state = 1
  pageData.showSyncGate = false
  pausedSec = 0
  audioUnlocked = false
  wsManualClose = false
  wsRetryCount = 0

  let userData = ptUtil.getUserData()
  nickName = userData.nickName as string
  localId = userData.nonce as string
  
  let res = await request_enter(roomId, nickName)
  enterResToErrState(res)
  if(!res) return
  let { code, data } = res
  if(code === "0000") {
    pageData.state = 2
    await nextTick()
    afterEnter(data as RoRes)
  }
}

function enterResToErrState(res?: RequestRes) {
  if(!res) {
    pageData.state = 13
    return
  }
  let { code } = res
  if(code === "0000") {
    return
  }
  else if(code === "E4004") {
    pageData.state = 12
  }
  else if(code === "E4006") {
    pageData.state = 11
  }
  else if(code === "E4003") {
    pageData.state = 14
  }
  else if(code === "R0001") {
    pageData.state = 15
  }
  else {
    pageData.state = 20
  }
}

// 成功进入房间后: 
//    赋值 / 创建播放器 / 开启 20s 轮询机制 / 建立 webSocket
function afterEnter(roRes: RoRes) {
  guestId = roRes?.guestId ?? ""
  pageData.content = roRes.content
  pageData.amIOwner = roRes?.iamOwner === "Y" ? true : false
  pageData.participants = showParticipants(roRes.participants, guestId)
  pageData.showMoreBox = handleShowMoreBox(roRes.content)

  createPlayer()
  heartbeat()
  connectWebSocket()
  shareData(roRes.content, roRes.playStatus, nickName)
}

// 创建播放器
function createPlayer() {
  let content = pageData.content as ContentData

  waitPlayer = new Promise((a: SimpleFunc) => {
    playerAlready = a
  })

  const audio = {
    src: content.audioUrl,
    title: content.title,
    cover: content.imageUrl || images.APP_LOGO,
    artist: content.seriesName,
  }

  const durationchange = (duration?: number) => {
    if(duration) srcDuration = duration
    showPage()
  }
  const canplay = (e: Event) => {}
  const loadeddata = (e: Event) => {}

  const pause = (e: Event) => {
    playStatus = "PAUSED"
    if(isRemoteSetPaused) {
      isRemoteSetPaused = false
      return
    }
    // iOS 切到后台时可能误发 pause，此时不要用过期状态去改房间
    if (document.visibilityState === "hidden") return
    collectLatestStatus()
  }
  const playing = (e: Event) => {
    pausedSec = 0
    playStatus = "PLAYING"
    if(isRemoteSetPlaying) {
      isRemoteSetPlaying = false
      return
    }
    collectLatestStatus()
  }
  const ratechange = (e: Event) => {
    if(isRemoteSetSpeedRate) {
      isRemoteSetSpeedRate = false
      return
    }
    collectLatestStatus()
  }
  const seeked = (e: Event) => {
    if(isRemoteSetSeek) {
      isRemoteSetSeek = false
      return
    }
    collectLatestStatus()
  }
  const callbacks = {
    durationchange,
    canplay,
    loadeddata,
    pause,
    playing,
    ratechange,
    seeked
  }

  const onBeforeClick = (target: string): boolean => {
    if(pageData.amIOwner || !target) return true
    const list = ["play_or_pause", "forward", "backward", "speed", "seek"]
    const isRestricted = list.includes(target)
    if(pageData.everyoneCanOperatePlayer === "N" && isRestricted) {
      showOperateFailed()
      return false
    }
    return true
  }

  player = initPlayer(playerEl, audio, callbacks, onBeforeClick)
  enhanceAudioElement(player, playerEl.value)
  bindMediaSession({
    getPlayer: () => player,
    getPageData: () => pageData,
    getLatestStatus: () => latestStatus,
    getPlayStatus: () => playStatus,
    canOperatePlayer,
  }, content)
  maybeOfferSyncGate()
  checkPlayerReady()
}

let lastShowOperateFailed = 0
function showOperateFailed() {
  const now = time.getLocalTime()
  if(lastShowOperateFailed + 500 > now) return
  lastShowOperateFailed = now
  cui.showModal({
    title: "提示",
    content: "房主已设置仅房主能操作播放器。不过，你仍然可以调整是否静音（在\"...\"里）。",
    showCancel: false,
  })
}

function isAppleMobile(): boolean {
  const cha = ptApi.getCharacteristic()
  return !!(cha.isIOS || cha.isIPadOS)
}

function maybeOfferSyncGate() {
  if (audioUnlocked) return
  if (isAppleMobile()) {
    pageData.showSyncGate = true
  }
}

// 开始检测 player 是否已经 ready
async function checkPlayerReady() {
  if(!isAppleMobile()) {
    checkPlayerReadyAgain(6000)
    return
  }
  // iOS 在没有用户手势前经常拿不到 duration，先把房间界面和「点击开始」遮罩亮出来
  await util.waitMilli(800)
  if (pageData.state <= 2) {
    showPage()
  }
  maybeOfferSyncGate()
  checkPlayerReadyAgain(12000)
}

// 初始化播放器后再次检查播放器，是否加载到播放时长
async function checkPlayerReadyAgain(waitMs: number = 6000) {
  await util.waitMilli(waitMs)
  if(pageData.state >= 3 && srcDuration) return
  // 还在等用户点遮罩解锁时，不要误报「未知的异常」
  if (pageData.showSyncGate && !audioUnlocked) return
  if(pageData.state >= 3) return
  console.log("######## 等了若干秒无果，切换到未知的异常 ########")
  console.log(" ")
  pageData.state = 19
}

function showPage(): void {
  if(pageData.state <= 2) {
    pageData.state = 3
    playerAlready(true)
  }
}

async function onTapSyncGate() {
  if (!player) return
  audioUnlocked = true
  pageData.showSyncGate = false
  await unlockAudioElement(player)
  if (srcDuration) {
    await receiveNewStatus("check")
  } else {
    // 解锁后再给解码一点时间
    await util.waitMilli(400)
    if (srcDuration) await receiveNewStatus("check")
  }
  updatePositionState()
}

// 收集最新状态，再用 ws 上报
function collectLatestStatus() {
  lastOperateLocalStamp = time.getLocalTime()
  if(timeoutCollect) clearTimeout(timeoutCollect)

  const _collect = () => {
    if(!player) return
    if(!canOperatePlayer()) return
    if (document.visibilityState === "hidden") return

    const currentTime = currentAudioTime()
    let contentStamp = currentTime * 1000
    contentStamp = util.numToFix(contentStamp, 0)
    let param: Record<string, any> = {
      operateType: "SET_PLAYER",
      roomId: pageData.roomId,
      "x-pt-local-id": localId,
      "x-pt-stamp": time.getTime(),
      playStatus,
      speedRate: String(player.playbackRate),
      contentStamp,
    }
    if(pageData.amIOwner) {
      param.everyoneCanOperatePlayer = pageData.everyoneCanOperatePlayer
    }
    sendToWebSocket(ws, param)
    checkOperated()
  }

  timeoutCollect = setTimeout(() => {
    _collect()
  }, COLLECT_TIMEOUT)
}

// 检查操作播放器 远端是否有收到
async function checkOperated() {
  await util.waitMilli(2500)
  const now = time.getLocalTime()
  const diff = now - lastNewStatusFromWsStamp
  console.log("检查操作播放器远端是否接收 时间差 (理想状态小于 2500):")
  console.log(diff)
  console.log(" ")
  if(diff < 3000) return

  // 去重新连接 web-socket
  connectWebSocket()
}

// 每若干秒的心跳
function heartbeat() {
  const _env = util.getEnv()
  heartbeatNum = 0
  lastHeartbeatStamp = 0

  const _closeRoom = (val: PageState, sendLeave: boolean = false) => {
    pageData.state = val
    leaveRoom(sendLeave)
  }

  const _newRoomStatus = (roRes: RoRes) => {
    pageData.content = roRes.content
    pageData.participants = showParticipants(roRes.participants, guestId)

    const now = time.getLocalTime()
    const diff1 = now - lastOperateLocalStamp
    const diff2 = now - lastNewStatusFromWsStamp
    if(diff1 < 900) {
      console.log("刚刚 900ms 内本地有操作播放器")
      console.log("故不采纳心跳的 info")
      console.log(" ")
      return
    }
    if(diff2 < 900) {
      console.log("刚刚 900ms 内 web-socket 发来了最新状态")
      console.log("故不采纳心跳的 info")
      console.log(" ")
      return
    }

    latestStatus = {
      roomId: roRes.roomId,
      playStatus: roRes.playStatus,
      speedRate: roRes.speedRate,
      operator: roRes.operator,
      contentStamp: roRes.contentStamp,
      operateStamp: roRes.operateStamp
    }
    if(roRes.everyoneCanOperatePlayer) {
      pageData.everyoneCanOperatePlayer = roRes.everyoneCanOperatePlayer
    }
    receiveNewStatus("http")
  }

  const _webSocketHb = () => {
    const send = {
      operateType: "HEARTBEAT",
      roomId: pageData.roomId,
      "x-pt-local-id": localId,
      "x-pt-stamp": time.getTime()
    }
    sendToWebSocket(ws, send)
  }

  intervalHb = setInterval(async () => {

    // 心跳数有没有超过最大值
    heartbeatNum++
    if(heartbeatNum > MAX_HB_NUM) {
      _closeRoom(16, true)
      return
    }

    // 检查上一次心跳的时间，如果超过 35s
    // 就代表被浏览器限制定时了，执行 resume
    const now = time.getLocalTime()
    if(lastHeartbeatStamp > 0 && lastHeartbeatStamp + 35000 < now) {
      silentRecover()
      return
    }
    lastHeartbeatStamp = now

    // 检查是否已暂停 5 分钟
    if(playStatus === "PAUSED") {
      pausedSec += _env.HEARTBEAT_PERIOD
      if(pausedSec >= (5 * 60)) {
        _closeRoom(17, true)
        return
      }
    }
    else pausedSec = 0

    const res = await request_heartbeat(pageData.roomId, nickName)
    if(!res) return
    const { code, data } = res
    if(code === "0000") {
      _newRoomStatus(data as RoRes)
      _webSocketHb()
    }
    else if(code === "E4004") _closeRoom(12, false)
    else if(code === "E4006") _closeRoom(11, false)
    else if(code === "E4003") _closeRoom(14, false)

  }, _env.HEARTBEAT_PERIOD * 1000)
}

// 用户息屏后、再打开，可能在这之间的定时器被浏览器限制了，或 WebSocket 已断开。
// 静默拉房间快照并对齐，不要打断正在播的音频，也不要弹出「请稍等」。
async function silentRecover() {
  if (recovering) return
  if (pageData.state !== 2 && pageData.state !== 3) return
  recovering = true
  pausedSec = 0
  console.log("执行 silentRecover......................")

  try {
    await time.calibrateTime()

    if (!isWsOpen(ws)) {
      connectWebSocket()
    }

    let res = await request_heartbeat(pageData.roomId, nickName)
    if (res && (res.code === "E4003" || res.code === "E4004" || res.code === "E4006")) {
      // 心跳认为不在房间里时再走一次进入，仍不销毁播放器
      res = await request_enter(pageData.roomId, nickName)
    }
    if (!res) return
    if (res.code !== "0000") {
      enterResToErrState(res)
      if (pageData.state >= 11) leaveRoom(false)
      return
    }
    const roRes = res.data as RoRes
    if (roRes.guestId) guestId = roRes.guestId
    pageData.content = roRes.content
    pageData.participants = showParticipants(roRes.participants, guestId)
    if (roRes.iamOwner) pageData.amIOwner = roRes.iamOwner === "Y"
    if (roRes.everyoneCanOperatePlayer) {
      pageData.everyoneCanOperatePlayer = roRes.everyoneCanOperatePlayer
    }

    latestStatus = {
      roomId: roRes.roomId,
      playStatus: roRes.playStatus,
      speedRate: roRes.speedRate,
      operator: roRes.operator,
      contentStamp: roRes.contentStamp,
      operateStamp: roRes.operateStamp,
    }
    await receiveNewStatus("http")

    // 心跳定时器如果已被清掉，重新拉起
    if (!intervalHb) heartbeat()
    lastHeartbeatStamp = time.getLocalTime()
  } finally {
    recovering = false
  }
}

function scheduleWsReconnect() {
  if (wsManualClose) return
  if (pageData.state !== 2 && pageData.state !== 3) return
  const now = time.getLocalTime()
  if (lastReConnectWs + 800 > now) return
  lastReConnectWs = now
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
  const delay = Math.min(1000 * (2 ** Math.min(wsRetryCount, 3)), 8000)
  wsRetryCount++
  console.log("将在", delay, "ms 后重连 websocket, 第", wsRetryCount, "次")
  wsReconnectTimer = window.setTimeout(() => {
    connectWebSocket()
  }, delay)
}

// 使用 web-socket 去建立连接
function connectWebSocket() {
  if (wsManualClose) return
  receiveWsNum = 0
  const myToken = ++wsCheckToken

  // 先丢掉旧连接，避免重复
  if (ws) {
    try {
      ws.onclose = null
      ws.onmessage = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    } catch (err) {}
    ws = null
  }

  const onmessage = (msgRes: WsMsgRes) => {
    receiveWsNum++
    const { responseType: rT, roomStatus } = msgRes

    // 刚连接
    if(rT === "CONNECTED") {
      firstSend()
    }
    else if(rT === "NEW_STATUS" && roomStatus) {
      lastNewStatusFromWsStamp = time.getLocalTime()
      latestStatus = roomStatus
      if(roomStatus.everyoneCanOperatePlayer) {
        pageData.everyoneCanOperatePlayer = roomStatus.everyoneCanOperatePlayer
      }
      receiveNewStatus()
    }
    else if(rT === "HEARTBEAT") {
      console.log("收到 ws 的HEARTBEAT.......")
      console.log(" ")
    }
  }

  const onopen = () => {
    wsRetryCount = 0
  }

  const onclose = (closeEvent: CloseEvent) => {
    console.log("websocket closed, code =", closeEvent.code)
    if (wsManualClose) return
    scheduleWsReconnect()
  }

  const callbacks = {
    onmessage,
    onopen,
    onclose
  }
  ws = initWebSocket(callbacks)
  checkWebSocket(myToken)
}

// 等待 5s 查看 web-socket 是否连接；失败则重连，不要直接把人踢出房间
async function checkWebSocket(token: number) {
  await util.waitMilli(5000)
  if (token !== wsCheckToken) return
  if (wsManualClose) return
  if (pageData.state !== 2 && pageData.state !== 3) return
  if(receiveWsNum < 2) {
    console.log("websocket 5s 内未就绪，尝试重连而不是离开房间")
    scheduleWsReconnect()
  }
}

// "首次发送" 给 websocket
function firstSend() {
  const send = {
    operateType: "FIRST_SEND",
    roomId: pageData.roomId,
    "x-pt-local-id": localId,
    "x-pt-stamp": time.getTime()
  }
  sendToWebSocket(ws, send)
}

async function receiveNewStatus(fromType: RevokeType = "ws") {
  if(!latestStatus || latestStatus.roomId !== pageData.roomId) return
  if (!player) return

  await waitPlayer
  let { contentStamp } = latestStatus

  // 还没解析出时长时不要按 0 去 seek，否则会把进度打回开头
  if (!srcDuration) {
    maybeOfferSyncGate()
    return
  }

  // 正在播放时以 audio.currentTime 为准，不要用被挂起的定时器推算本地进度
  const localCurrent = currentAudioTime()
  let reSeekSec = playerTool.getReSeek(latestStatus, srcDuration, localCurrent, fromType)
  if(reSeekSec >= 0) {
    isRemoteSetSeek = true
    seekPrecise(player, reSeekSec)
    checkSeek()
  }

  // 判断倍速
  let rSpeedRate = latestStatus.speedRate
  let speedRate = String(player.playbackRate)

  if(rSpeedRate !== speedRate) {
    console.log("播放器倍速不一致，请求调整......")
    isRemoteSetSpeedRate = true
    let speedRateNum = Number(rSpeedRate)
    player.playbackRate = speedRateNum
  }

  // 判断播放状态
  let rPlayStatus = latestStatus.playStatus
  let diff2 = (srcDuration * 1000) - contentStamp
  if(rPlayStatus !== playStatus) {
    // 如果剩下 1s 就结束了 还要播放，进行阻挡
    if(rPlayStatus === "PLAYING" && diff2 < 1000) return
    if(rPlayStatus === "PLAYING" && !isShowingAutoPlayPolicy) {
      if (!audioUnlocked && isAppleMobile()) {
        maybeOfferSyncGate()
        return
      }
      console.log("远端请求播放......")
      isRemoteSetPlaying = true
      try {
        const ret = player.play()
        if (ret && typeof ret.catch === "function") {
          ret.catch((err: any) => {
            console.log("播放失败.....")
            console.log(err)
            handleAutoPlayPolicy()
          })
        }
      }
      catch(err) {
        console.log("播放失败.....")
        console.log(err)
        handleAutoPlayPolicy()
      }
      checkIsPlaying()
    }
    else if(rPlayStatus === "PAUSED") {
      console.log("远端请求暂停......")
      isRemoteSetPaused = true
      player.pause()
    }
  }
  updatePositionState()
}

// 由于 iOS 初始化时设置时间点 会不起作用
// 所以重新做检查
async function checkSeek() {
  await util.waitMilli(600)
  let reSeekSec = playerTool.getReSeek(latestStatus, srcDuration, currentAudioTime(), "check")
  if(reSeekSec >= 0) {
    isRemoteSetSeek = true
    seekPrecise(player, reSeekSec)
  }
}

async function checkIsPlaying() {
  await util.waitMilli(1500)
  const rPlayStatus = latestStatus.playStatus
  if(rPlayStatus === "PLAYING" && playStatus === "PAUSED") {
    handleAutoPlayPolicy()
  }
}

async function handleAutoPlayPolicy() {
  if(isShowingAutoPlayPolicy) return
  if (pageData.showSyncGate) return

  // iOS / 自动播放被拦截：改用全屏「点击开始同步收听」，一次手势解锁后对齐房间进度
  if (!audioUnlocked) {
    pageData.showSyncGate = true
    return
  }

  isShowingAutoPlayPolicy = true
  let res1 = await cui.showModal({
    title: "当前房间正在播放",
    content: "🔇还是🔊？",
    cancelText: "静音",
    confirmText: "开声音"
  })
  isShowingAutoPlayPolicy = false

  // 如果是静音
  if(res1.cancel) {
    player.muted = true
  }

  // 调整进度条
  let reSeekSec = playerTool.getReSeek(latestStatus, srcDuration, currentAudioTime(), "check")
  if(reSeekSec >= 0) {
    isRemoteSetSeek = true
    seekPrecise(player, reSeekSec)
  }

  // 开始播放
  if(latestStatus.playStatus === "PLAYING") {
    isRemoteSetPlaying = true
    player.play()
  }
}


// 离开房间
async function leaveRoom(sendLeave: boolean = true) {
  wsManualClose = true
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = 0
  }
  wsCheckToken++
  pageData.showSyncGate = false
  audioUnlocked = false
  unbindLifecycle()
  clearMediaSession()

  // 销毁心跳
  if(intervalHb) clearInterval(intervalHb)
  intervalHb = 0

  // 关闭 web-socket
  if(ws) {
    try { ws.close() } catch (err) {}
    ws = null
  }

  // 销毁播放器（只在真正离开房间时；前后台切换不会走到这里）
  if(player) {
    player.destroy()
    player = null
  }

  if(!sendLeave) return
  // 去发送离开房间的请求
  await request_leave(pageData.roomId, nickName)
}
