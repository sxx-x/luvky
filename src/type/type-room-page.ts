// 仅用于 room-page 的类型
import { ContentData } from "./index"

/**
 * 3: 可以收听
 * 15: 已经有两个人在一起听了
 * 断线时安静重连，不展示踢出文案。
 */
export type PageState = 1 | 2 | 3 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20

export interface PageParticipant {
  guestId: string
  nickName: string
  enterStr: string      // xx 分钟前进入
  isMe: boolean
}

export interface PageData {
  state: PageState
  roomId: string,
  content?: ContentData | null,
  participants: PageParticipant[],
  showMoreBox: boolean,
  amIOwner: boolean,
  everyoneCanOperatePlayer: "Y" | "N"
  showSyncGate: boolean
  parsing: boolean
  notice: string
}

type SpeedRate = "0.8" | "1" | "1.2" | "1.5" | "1.7"

export type PlayStatus = "PLAYING" | "PAUSED"

export interface RoomStatus {
  playStatus: PlayStatus
  speedRate: SpeedRate
  operator: string
  contentStamp: number
  operateStamp: number
}

export interface WsMsgRes {
  responseType: "CONNECTED" | "NEW_STATUS" | "NEW_CONTENT" | "HEARTBEAT" | "ERROR"
  content?: ContentData | null
  roomStatus?: RoomStatus
  code?: string
  errMsg?: string
  showMsg?: string
}

export type RevokeType = "ws" | "http" | "check"


