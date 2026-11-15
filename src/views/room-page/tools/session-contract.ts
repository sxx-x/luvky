export const SESSION_FULL_TEXT = "已经有两个人在一起听了"

export function isSessionFull(res?: { code?: string; errMsg?: string } | null): boolean {
  return res?.code === "R0001" || res?.errMsg === "SESSION_FULL"
}
