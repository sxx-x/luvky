import assert from "node:assert/strict"
import test from "node:test"
import {
  SLEEP_MINUTES,
  carrySleepFields,
  createSleepTimerClient,
  formatSleepRemaining,
  isSleepCommand,
  remainingSleepMs,
} from "./sleep-timer.ts"

const NOW = 1_700_000_000_000
const END = NOW + 30 * 60_000
const NONE = { sleepMinutes: null, sleepEndStamp: null }
const ARMED = { sleepMinutes: 30, sleepEndStamp: END }

function playback(extra = {}) {
  return {
    playStatus: "PLAYING",
    speedRate: "1.5",
    operator: "guest",
    contentStamp: 2000,
    operateStamp: NOW,
    ...extra,
  }
}

test("choices are 15, 30, 45, and 60, and cancel is the number 0", () => {
  assert.deepEqual([...SLEEP_MINUTES], [15, 30, 45, 60])
  assert.equal(isSleepCommand(0), true)
  assert.equal(isSleepCommand(30), true)
  assert.equal(isSleepCommand(20), false)
})

test("remaining time is the shared deadline minus serverNow, not scaled by rate", () => {
  assert.equal(remainingSleepMs(END, NOW), 30 * 60_000)
  assert.equal(remainingSleepMs(END, NOW + 10_000), 30 * 60_000 - 10_000)
  assert.equal(formatSleepRemaining(remainingSleepMs(END, NOW)), "30:00")
  assert.equal(formatSleepRemaining(remainingSleepMs(NOW + 60 * 60_000, NOW)), "1:00:00")
  assert.equal(formatSleepRemaining(remainingSleepMs(NOW + 15 * 60_000, NOW + 1000)), "14:59")
  assert.equal(remainingSleepMs(null, NOW), null)
})

test("heartbeat status keeps sleepMinutes and sleepEndStamp", () => {
  const first = carrySleepFields(playback({ sleepMinutes: 30, sleepEndStamp: END }), NONE)
  assert.deepEqual(first, ARMED)

  const tenSecondsLater = playback({
    contentStamp: 17000,
    operateStamp: NOW + 10_000,
    sleepMinutes: 30,
    sleepEndStamp: END,
  })
  const kept = carrySleepFields(tenSecondsLater, first)
  assert.equal(kept.sleepMinutes, 30)
  assert.equal(kept.sleepEndStamp, END)
  assert.equal(remainingSleepMs(kept.sleepEndStamp, NOW + 10_000), 30 * 60_000 - 10_000)

  const stripped = carrySleepFields(playback(), kept)
  assert.deepEqual(stripped, kept)
})

test("ENTER, NEW_STATUS, and a new episode carry the same fields", () => {
  const entered = carrySleepFields(playback({
    playStatus: "PAUSED",
    sleepMinutes: 15,
    sleepEndStamp: NOW + 15 * 60_000,
  }), NONE)
  assert.equal(entered.sleepMinutes, 15)

  const episode = carrySleepFields(playback({
    playStatus: "PAUSED",
    speedRate: "1",
    contentStamp: 0,
    sleepMinutes: 15,
    sleepEndStamp: NOW + 15 * 60_000,
  }), NONE)
  assert.equal(episode.sleepMinutes, 15)
  assert.equal(episode.sleepEndStamp, entered.sleepEndStamp)

  const fired = carrySleepFields(playback({
    playStatus: "PAUSED",
    operator: "",
    sleepMinutes: null,
    sleepEndStamp: null,
  }), episode)
  assert.deepEqual(fired, NONE)
})

test("both people read one shared deadline", () => {
  const shared = carrySleepFields(playback({ sleepMinutes: 45, sleepEndStamp: NOW + 45 * 60_000 }), NONE)
  const a = remainingSleepMs(shared.sleepEndStamp, NOW + 1000)
  const b = remainingSleepMs(shared.sleepEndStamp, NOW + 1000)
  assert.equal(formatSleepRemaining(a), formatSleepRemaining(b))
  assert.equal(formatSleepRemaining(remainingSleepMs(shared.sleepEndStamp, NOW)), "45:00")
  assert.equal(formatSleepRemaining(a), "44:59")
})

test("set, change, and cancel publish sleepMinutes as a number", async () => {
  const sent = []
  let shared = NONE
  const client = createSleepTimerClient({
    getEndStamp: () => shared.sleepEndStamp,
    publishMinutes: async (minutes) => {
      sent.push(minutes)
      assert.equal(typeof minutes, "number")
      if (minutes === 0) {
        shared = NONE
        return
      }
      shared = { sleepMinutes: minutes, sleepEndStamp: NOW + minutes * 60_000 }
    },
  })

  await client.setMinutes(15)
  const first = client.getEndStamp()
  await client.setMinutes(15)
  assert.equal(client.getEndStamp(), NOW + 15 * 60_000)
  assert.equal(first, client.getEndStamp())
  await client.setMinutes(45)
  assert.equal(shared.sleepMinutes, 45)
  await client.cancel()
  assert.equal(client.getEndStamp(), null)
  assert.deepEqual(sent, [15, 15, 45, 0])
})
