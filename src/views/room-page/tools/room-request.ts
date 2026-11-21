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

/** Set, replace, or cancel the shared sleep timer. 0 cancels. The body value is a JSON number. */
export const request_set_sleep = async (
  sleepMinutes: 0 | 15 | 30 | 45 | 60,
): Promise<RequestRes<RoRes>> => {
  return rq.request<RoRes>(url, { operateType: "SET_SLEEP", sleepMinutes })
}

