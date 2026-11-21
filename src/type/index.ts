
/**************** 网络请求 **************/
// 请求回调的公共入参
export interface RequestParam {
  "x-pt-version": string
  "x-pt-client": string
  "x-pt-stamp": number
  "x-pt-language": string
  "x-pt-local-id": string
  [otherParam: string]: any
}

// 请求回调的结果
export interface RequestRes<T = Record<string, any>> {
  code: string
  errMsg?: string
  showMsg?: string
  data?: T
}

/**************** 一些正常情况下的返回参数 *************/
export interface Participant {
  guestId: string
  heartbeatStamp: number
  enterStamp: number
  nickName?: string
}

export interface ContentData {
  infoType: "podcast"
  audioUrl: string
  sourceType?: string
  title?: string
  description?: string
  imageUrl?: string
  linkUrl?: string
  seriesName?: string   // 播客专栏名称，比如 "商业就是这样"
  seriesUrl?: string    // 播客专栏链接
}

export type SleepMinutes = 15 | 30 | 45 | 60

export interface RoRes {
  content: ContentData | null
  playStatus: "PLAYING" | "PAUSED"
  speedRate: "0.8" | "1" | "1.2" | "1.5" | "1.7"
  operator: string
  contentStamp: number
  operateStamp: number
  /** Chosen duration. Null means no timer. It does not shrink as time passes. */
  sleepMinutes: SleepMinutes | null
  /** Server wall-clock ms when playback pauses. Null means no timer. */
  sleepEndStamp: number | null
  participants: Participant[]
  guestId?: string
  roomId?: string
  iamOwner?: "Y" | "N"
  everyoneCanOperatePlayer?: "Y" | "N"
}


/********************* 纯前端的类型 **********************/
export interface StorageUserData {
  nickName?: string
  nonce?: string
}

export interface EnvType {
  DEV: boolean
  WEBSOCKET_URL: string
  API_URL: string
  HEARTBEAT_PERIOD: number
  THIRD_PARTY_SETTING_URL?: string
  CONTACT_EMAIL?: string
  CONTACT_FEISHU?: string
  PLAUSIBLE_DOMAIN?: string
  PLAUSIBLE_SRC?: string
}