/**
 * Playing-page sleep timer.
 *
 * The session owns the deadline. SET_SLEEP sends sleepMinutes as a number:
 * 15, 30, 45, or 60 to set or replace it, or 0 to cancel. The server answers
 * with sleepMinutes (the chosen duration, it does not shrink) and
 * sleepEndStamp (server wall-clock ms, same clock as time.getTime()).
 * Both people render sleepEndStamp - serverNow. Playback rate is not part
 * of that subtraction. The pause at the deadline arrives as NEW_STATUS.
 */

export const SLEEP_MINUTES = [15, 30, 45, 60] as const

export type SleepMinutes = (typeof SLEEP_MINUTES)[number]

export type SleepCommand = 0 | SleepMinutes

export interface SleepFields {
  sleepMinutes: SleepMinutes | null
  sleepEndStamp: number | null
}

export function isSleepMinutes(value: number): value is SleepMinutes {
  return value === 15 || value === 30 || value === 45 || value === 60
}

export function isSleepCommand(value: number): value is SleepCommand {
  return value === 0 || isSleepMinutes(value)
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key)
}

export function readSleepMinutes(value: unknown): SleepMinutes | null {
  if (value == null) return null
  if (typeof value === "number" && isSleepMinutes(value)) return value
  return null
}

export function readSleepEndStamp(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
  return value
}

/**
 * Copy the two shared fields onto the next room status.
 * A snapshot that includes them (including null) wins.
 * A snapshot that omits them keeps the previous values, so a mapper
 * that only forwarded play fields cannot blank the countdown.
 */
export function carrySleepFields(source: unknown, previous: SleepFields): SleepFields {
  if (!source || typeof source !== "object") return previous
  const record = source as Record<string, unknown>
  return {
    sleepMinutes: hasOwn(record, "sleepMinutes") ? readSleepMinutes(record.sleepMinutes) : previous.sleepMinutes,
    sleepEndStamp: hasOwn(record, "sleepEndStamp") ? readSleepEndStamp(record.sleepEndStamp) : previous.sleepEndStamp,
  }
}

/** Remaining milliseconds. Null when the session has no deadline. */
export function remainingSleepMs(endStamp: number | null, serverNow: number): number | null {
  if (endStamp == null) return null
  return endStamp - serverNow
}

export function formatSleepRemaining(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

export interface SleepTimerClient {
  getEndStamp(): number | null
  /** Set or replace the shared duration. The session echo supplies the deadline. */
  setMinutes(minutes: SleepMinutes): Promise<void>
  /** Cancel. Sends sleepMinutes 0. */
  cancel(): Promise<void>
}

export function createSleepTimerClient(deps: {
  getEndStamp: () => number | null
  publishMinutes: (minutes: SleepCommand) => Promise<void>
}): SleepTimerClient {
  return {
    getEndStamp: deps.getEndStamp,
    async setMinutes(minutes) {
      await deps.publishMinutes(minutes)
    },
    async cancel() {
      await deps.publishMinutes(0)
    },
  }
}
