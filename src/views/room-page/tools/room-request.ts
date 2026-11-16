import rq from "../../../request"
import { RequestRes, RoRes } from "../../../type"
import api from "../../../request/api"
import { isSessionFull, SESSION_FULL_TEXT } from "./session-contract"

const url = api.ROOM_OPERATE

export { isSessionFull, SESSION_FULL_TEXT }

export const request_enter = async (): Promise<RequestRes<RoRes>> => {
  return rq.request<RoRes>(url, { operateType: "ENTER" })
}

export const request_heartbeat = async (): Promise<RequestRes<RoRes>> => {
  return rq.request<RoRes>(url, { operateType: "HEARTBEAT" })
}

export const request_set_content = async (link: string): Promise<RequestRes<RoRes>> => {
  return rq.request<RoRes>(url, { operateType: "SET_CONTENT", link })
}

