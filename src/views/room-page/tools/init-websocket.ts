import util from "../../../utils/util"
import { WsMsgRes } from "../../../type/type-room-page"

interface WsCallbacks {
  onopen?: (socket: Event) => void
  onmessage?: (res: WsMsgRes) => void
  onclose?: (res: CloseEvent) => void
  onerror?: (res: Event) => void
}

export function getWebSocketUrl(): string {
  const { WEBSOCKET_URL } = util.getEnv()
  if (WEBSOCKET_URL) return WEBSOCKET_URL
  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${location.host}/ws`
}

export function initWebSocket(callbacks: WsCallbacks) {
  const url = getWebSocketUrl()
  let ws = new WebSocket(url)
  ws.onopen = (socket: Event) => {
    console.log("ws opened.........")
    callbacks.onopen && callbacks.onopen(socket)
  }

  ws.onmessage = (res) => {
    const message = res.data
    const msgRes = util.strToObj<WsMsgRes>(message)
    
    if(!msgRes) return
    callbacks.onmessage && callbacks.onmessage(msgRes)
  }

  ws.onclose = (res) => {
    console.log("ws.onclose.......")
    console.log(`res: `, res)
    console.log(` `)
    callbacks.onclose && callbacks.onclose(res)
  }

  ws.onerror = (res) => {
    console.log("ws.onerror.......")
    console.log(res)
    console.log(" ")
    callbacks.onerror && callbacks.onerror(res)
  }
  return ws
}


export function sendToWebSocket(ws: WebSocket | null, obj: Record<string, any>): boolean {
  let msg: string
  try {
    msg = JSON.stringify(obj)
  }
  catch(err) {
    console.log("解析失败")
    console.log(err)
    return false
  }
  if(!ws) {
    console.log("ws 不存在，无法发送...........")
    console.log(" ")
    return false
  }

  if (ws.readyState !== WebSocket.OPEN) {
    console.log("ws 尚未打开，无法发送...........")
    return false
  }
  
  if(obj.operateType === "SET_PLAYER") {
    console.log("使用 web-socket 操作播放器消息: ")
    console.log(obj)
    console.log(" ")
  }
  

  try {
    ws.send(msg)
  }
  catch(err) {
    console.log("使用 web-socket 发送消息失败.......")
    console.log(err)
    console.log(" ")
    return false
  }
  return true
}

export function isWsOpen(ws: WebSocket | null): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN
}
