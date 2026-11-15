import { ContentData } from "../../../type"
import { PageData, RoomStatus } from "../../../type/type-room-page"

interface MediaSessionCtx {
  getPlayer: () => any
  getPageData: () => PageData
  getLatestStatus: () => RoomStatus | undefined
  getPlayStatus: () => "PLAYING" | "PAUSED"
  canOperatePlayer: () => boolean
}

let lastPositionStamp = 0
let ctx: MediaSessionCtx | null = null
let timeupdateBound: HTMLAudioElement | null = null
let onTimeUpdate: (() => void) | null = null

function getAudio(player: any): HTMLAudioElement | undefined {
  return player?.audio as HTMLAudioElement | undefined
}

function canUse(): boolean {
  return typeof navigator !== "undefined" && "mediaSession" in navigator
}

export function enhanceAudioElement(player: any, container?: HTMLElement | null) {
  const audio = getAudio(player)
  if (!audio) return
  // Safari iOS honors playsInline on <audio>; DOM typings only declare it on HTMLVideoElement.
  ;(audio as HTMLAudioElement & { playsInline: boolean }).playsInline = true
  audio.setAttribute("playsinline", "true")
  audio.setAttribute("webkit-playsinline", "true")
  audio.setAttribute("x5-playsinline", "true")
  audio.preload = "auto"
  // 把 Audio 挂进 DOM，锁屏 / 后台在 iOS 上更稳一些
  if (container && !container.contains(audio)) {
    audio.setAttribute("style", "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;")
    container.appendChild(audio)
  }
}

export function seekPrecise(player: any, sec: number) {
  if (!player) return
  const duration = Number(player.duration || 0)
  let t = Number(sec)
  if (!Number.isFinite(t)) return
  if (duration && t > duration) t = duration
  if (t < 0) t = 0
  const audio = getAudio(player)
  if (audio) {
    audio.currentTime = t
    if (player.ui?.setProgress) player.ui.setProgress(t, null, duration || player.duration)
    return
  }
  player.seek(t)
}

export function bindMediaSession(next: MediaSessionCtx, content?: ContentData) {
  ctx = next
  if (!canUse()) return
  const player = next.getPlayer()
  if (!player) return

  // 覆盖 shikwasa 自带的 Media Session（它的 seekto 入参不兼容，且不会尊重「仅房主可操作」）
  player.initMediaSession = () => applyHandlers(content)
  applyHandlers(content)
  watchPosition(player)
}

function applyHandlers(content?: ContentData) {
  if (!canUse() || !ctx) return
  const player = ctx.getPlayer()
  if (!player) return

  try {
    const title = content?.title || "一起听播客"
    const artist = content?.seriesName || "一起听播客"
    const cover = content?.imageUrl
    const artwork = cover
      ? [
          { src: cover, sizes: "96x96", type: "image/png" },
          { src: cover, sizes: "180x180", type: "image/png" },
          { src: cover, sizes: "256x256", type: "image/png" },
          { src: cover, sizes: "512x512", type: "image/png" },
        ]
      : undefined
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album: artist, artwork })
  } catch (err) {
    console.log("mediaSession metadata failed", err)
  }

  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch { /* 某些系统不支持全部 action */ }
  }

  set("play", () => {
    if (!ctx) return
    const player = ctx.getPlayer()
    if (!player) return
    if (ctx.canOperatePlayer()) {
      player.play()
      return
    }
    // 非操控者：不要打乱房间，只取消本地静音；若本地因策略暂停则悄悄跟上进度
    player.muted = false
    const latest = ctx.getLatestStatus()
    if (latest?.playStatus === "PLAYING" && player.audio?.paused) {
      player.play()?.catch(() => {})
    }
  })

  set("pause", () => {
    if (!ctx) return
    const player = ctx.getPlayer()
    if (!player) return
    if (ctx.canOperatePlayer()) {
      player.pause()
      return
    }
    player.muted = true
  })

  const seekBy = (delta: number) => {
    if (!ctx) return
    if (!ctx.canOperatePlayer()) return
    const player = ctx.getPlayer()
    if (!player) return
    const current = Number(player.currentTime || 0)
    seekPrecise(player, current + delta)
  }

  set("seekbackward", (ev) => seekBy(-(ev.seekOffset || 10)))
  set("seekforward", (ev) => seekBy(ev.seekOffset || 10))
  set("seekto", (ev) => {
    if (!ctx || !ctx.canOperatePlayer()) return
    if (typeof ev.seekTime !== "number") return
    seekPrecise(ctx.getPlayer(), ev.seekTime)
  })

  updatePositionState()
}

function watchPosition(player: any) {
  const audio = getAudio(player)
  if (!audio) return
  if (timeupdateBound && onTimeUpdate) {
    timeupdateBound.removeEventListener("timeupdate", onTimeUpdate)
  }
  onTimeUpdate = () => updatePositionState()
  audio.addEventListener("timeupdate", onTimeUpdate)
  timeupdateBound = audio
}

export function updatePositionState() {
  if (!canUse() || !ctx) return
  const player = ctx.getPlayer()
  const audio = getAudio(player)
  if (!audio) return
  const duration = Number(audio.duration)
  const position = Number(audio.currentTime)
  const playbackRate = Number(audio.playbackRate) || 1
  if (!Number.isFinite(duration) || duration <= 0) return
  if (!Number.isFinite(position) || position < 0) return

  const now = Date.now()
  if (now - lastPositionStamp < 500 && navigator.mediaSession.playbackState) {
    // 仍更新 playbackState，位置稍作节流
  } else {
    lastPositionStamp = now
    try {
      const pos = Math.min(position, duration)
      navigator.mediaSession.setPositionState({ duration, playbackRate, position: pos })
    } catch { /* iOS 某些版本对 NaN / 越界更敏感 */ }
  }

  try {
    navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing"
  } catch { /* ignore */ }
}

export function clearMediaSession() {
  if (timeupdateBound && onTimeUpdate) {
    timeupdateBound.removeEventListener("timeupdate", onTimeUpdate)
  }
  timeupdateBound = null
  onTimeUpdate = null
  ctx = null
  if (!canUse()) return
  try { navigator.mediaSession.metadata = null } catch { /* ignore */ }
  try { navigator.mediaSession.playbackState = "none" } catch { /* ignore */ }
  const actions: MediaSessionAction[] = ["play", "pause", "seekbackward", "seekforward", "seekto"]
  for (const action of actions) {
    try { navigator.mediaSession.setActionHandler(action, null) } catch { /* ignore */ }
  }
}

/** 用一次短暂的播放解锁 iOS 自动播放限制，尽量不改变进度 */
export async function unlockAudioElement(player: any): Promise<boolean> {
  const audio = getAudio(player)
  if (!audio) return false
  const wasMuted = audio.muted
  const t = audio.currentTime
  try {
    audio.muted = true
    await audio.play()
    audio.pause()
    if (Number.isFinite(t)) audio.currentTime = t
    audio.muted = wasMuted
    return true
  } catch (err) {
    console.log("unlock audio failed", err)
    try { audio.muted = wasMuted } catch { /* ignore */ }
    return false
  }
}
