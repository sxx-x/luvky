import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createSession,
  PRESENCE_TTL_MS,
  MIN_OPERATE_GAP_MS,
  MAX_PARTICIPANTS,
  SPEED_RATES,
  SLEEP_MINUTES,
} from "./session.mjs"

const EPISODE = {
  infoType: "podcast",
  audioUrl: "https://media.xyzcdn.net/test-episode.m4a",
  sourceType: "xiaoyuzhou",
  title: "测试单集",
  description: "详细简介",
  imageUrl: "https://image.xyzcdn.net/cover.jpg",
  linkUrl: "https://www.xiaoyuzhoufm.com/episode/5e280fb0418a84a0461f7c2e",
  seriesName: "商业就是这样",
  seriesUrl: "https://www.xiaoyuzhoufm.com/podcast/5e280fa8418a84a0461f6c2e",
}

function clocked() {
  let time = 1_700_000_000_000
  const session = createSession(() => time)
  return {
    session,
    at(ms) {
      time = ms
    },
    advance(ms) {
      time += ms
    },
    now() {
      return time
    },
  }
}

test("presence window stays in the tens of seconds and is not an immediate kick", () => {
  assert.equal(MAX_PARTICIPANTS, 2)
  assert.ok(PRESENCE_TTL_MS >= 30_000 && PRESENCE_TTL_MS <= 120_000)
  assert.equal(MIN_OPERATE_GAP_MS, 250)
  assert.deepEqual(SPEED_RATES, ["0.8", "1", "1.2", "1.5", "1.7"])
  assert.deepEqual(SLEEP_MINUTES, [15, 30, 45, 60])
})

test("two people share one session and a third is rejected with SESSION_FULL", () => {
  const { session } = clocked()
  const a = session.enter("browser-a")
  const b = session.enter("browser-b")
  assert.equal(a.code, "0000")
  assert.equal(b.code, "0000")
  assert.equal(a.data.participants.length, 1)
  assert.equal(b.data.participants.length, 2)
  assert.notEqual(a.data.guestId, b.data.guestId)
  assert.equal(session.participantCount(), 2)

  const third = session.enter("browser-c")
  assert.deepEqual(third, {
    code: "R0001",
    errMsg: "SESSION_FULL",
    showMsg: "已经有两个人在一起听了",
  })
  assert.equal(session.participantCount(), 2)
  assert.deepEqual(
    session.heartbeat("browser-a").data.participants.map((item) => item.guestId),
    [a.data.guestId, b.data.guestId],
  )
})

test("refreshing the same local id keeps one slot and the same guestId", () => {
  const { session, advance } = clocked()
  const first = session.enter("browser-a")
  session.enter("browser-b")
  advance(PRESENCE_TTL_MS - 1)
  const again = session.enter("browser-a")
  assert.equal(again.code, "0000")
  assert.equal(again.data.guestId, first.data.guestId)
  assert.equal(again.data.participants.length, 2)
  assert.equal(session.enter("browser-c").errMsg, "SESSION_FULL")
})

test("a dropped person still holds the slot until the presence window, then the episode remains", () => {
  const { session, advance } = clocked()
  const a = session.enter("browser-a")
  session.enter("browser-b")
  const saved = session.setContent("browser-a", EPISODE)
  assert.equal(saved.code, "0000")
  assert.equal(saved.data.content.audioUrl, EPISODE.audioUrl)

  advance(PRESENCE_TTL_MS - 1)
  assert.equal(session.enter("browser-c").errMsg, "SESSION_FULL")

  advance(1)
  const third = session.enter("browser-c")
  assert.equal(third.code, "0000")
  assert.equal(third.data.participants.length, 1)
  assert.equal(third.data.participants[0].guestId, third.data.guestId)
  assert.equal(third.data.content.linkUrl, EPISODE.linkUrl)
  assert.equal(third.data.playStatus, "PAUSED")
  assert.notEqual(third.data.guestId, a.data.guestId)
})

test("there is no link-expiry timer; a day later the episode is still in memory", () => {
  const { session, advance } = clocked()
  session.enter("browser-a")
  session.setContent("browser-a", EPISODE)
  advance(24 * 60 * 60 * 1000)
  session.cleanupPlaying()
  const again = session.enter("browser-a")
  assert.equal(again.data.content.audioUrl, EPISODE.audioUrl)
  assert.equal(again.data.participants.length, 1)
  assert.equal(session.hasContent(), true)
})

test("both participants can play, pause, seek, and change rate; nothing here is host-only", () => {
  const { session, now } = clocked()
  const a = session.enter("browser-a")
  const b = session.enter("browser-b")
  session.setContent("browser-a", EPISODE)

  const play = session.setPlayer("browser-a", now() + 10, {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 0,
    volume: 0,
    muted: true,
    everyoneCanOperatePlayer: "N",
  })
  assert.equal(play.code, "0000")
  assert.equal(play.roomStatus.operator, a.data.guestId)
  assert.deepEqual(Object.keys(play.roomStatus).sort(), [
    "contentStamp",
    "operateStamp",
    "operator",
    "playStatus",
    "sleepEndStamp",
    "sleepMinutes",
    "speedRate",
  ])
  assert.equal(play.roomStatus.sleepMinutes, null)
  assert.equal(play.roomStatus.sleepEndStamp, null)

  const seek = session.setPlayer("browser-b", now() + 20, {
    playStatus: "PLAYING",
    speedRate: 1.5,
    contentStamp: 40000,
  })
  assert.equal(seek.code, "0000")
  assert.equal(seek.roomStatus.playStatus, "PLAYING")
  assert.equal(seek.roomStatus.speedRate, "1.5")
  assert.equal(seek.roomStatus.contentStamp, 40000)
  assert.equal(seek.roomStatus.operator, b.data.guestId)
  assert.equal(seek.roomStatus.operateStamp, now() + 20)

  const pause = session.setPlayer("browser-a", now() + MIN_OPERATE_GAP_MS + 30, {
    playStatus: "PAUSED",
    speedRate: "0.8",
    contentStamp: 42000,
  })
  assert.equal(pause.roomStatus.playStatus, "PAUSED")
  assert.equal(pause.roomStatus.speedRate, "0.8")
  assert.equal(pause.roomStatus.contentStamp, 42000)
  assert.equal(pause.roomStatus.operator, a.data.guestId)
})

test("the same person cannot spam player updates inside 250ms, the other person can", () => {
  const { session, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  const stamp = now() + 50
  assert.equal(session.setPlayer("browser-a", stamp, {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 1000,
  }).code, "0000")
  assert.equal(session.setPlayer("browser-a", stamp + MIN_OPERATE_GAP_MS - 1, {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 9999,
  }).ignore, "TOO_SOON")
  const other = session.setPlayer("browser-b", stamp + 10, {
    playStatus: "PAUSED",
    speedRate: "1.2",
    contentStamp: 2500,
  })
  assert.equal(other.code, "0000")
  assert.equal(other.roomStatus.contentStamp, 2500)
  assert.equal(session.roomStatus().contentStamp, 2500)
})

test("player commands are ignored until a xiaoyuzhou episode is attached", () => {
  const { session, now } = clocked()
  session.enter("browser-a")
  const ignored = session.setPlayer("browser-a", now(), {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 0,
  })
  assert.equal(ignored.ignore, "NO_CONTENT")
  assert.equal(session.roomStatus().playStatus, "PAUSED")
})

test("non-xiaoyuzhou content cannot replace the episode", () => {
  const { session } = clocked()
  session.enter("browser-a")
  session.setContent("browser-a", EPISODE)
  const rejected = session.setContent("browser-a", {
    infoType: "podcast",
    audioUrl: "https://example.com/show.mp3",
    sourceType: "cdn",
    title: "not xiaoyuzhou",
  })
  assert.equal(rejected.errMsg, "XIAOYUZHOU_EPISODE_ONLY")
  assert.equal(session.heartbeat("browser-a").data.content.audioUrl, EPISODE.audioUrl)
})

test("setting a new episode resets playback and does not block the next play", () => {
  const { session, now } = clocked()
  session.enter("browser-a")
  session.setContent("browser-a", EPISODE)
  session.setPlayer("browser-a", now() + 10, {
    playStatus: "PLAYING",
    speedRate: "1.7",
    contentStamp: 8000,
  })
  const next = {
    ...EPISODE,
    audioUrl: "https://media.xyzcdn.net/next.m4a",
    title: "下一集",
  }
  const replaced = session.setContent("browser-a", next)
  assert.equal(replaced.data.playStatus, "PAUSED")
  assert.equal(replaced.data.speedRate, "1")
  assert.equal(replaced.data.contentStamp, 0)
  assert.equal(replaced.data.operator, "")
  assert.equal(replaced.data.content.title, "下一集")
  const play = session.setPlayer("browser-a", now() + 20, {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 0,
  })
  assert.equal(play.code, "0000")
})

test("the last person leaving pauses in place and keeps the episode for the next join", () => {
  const { session, now, advance } = clocked()
  session.enter("browser-a")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-a", started, {
    playStatus: "PLAYING",
    speedRate: "1.2",
    contentStamp: 1000,
  })
  advance(5000)
  session.heartbeat("browser-a")
  const leftAt = now()
  assert.deepEqual(session.leave("browser-a"), { code: "0000" })
  assert.equal(session.participantCount(), 0)
  assert.equal(session.hasContent(), true)
  const next = session.enter("browser-b")
  assert.equal(next.data.playStatus, "PAUSED")
  assert.equal(next.data.content.audioUrl, EPISODE.audioUrl)
  const elapsed = session.heartbeat("browser-a")
  assert.equal(elapsed.code, "E4003")
  const paused = session.heartbeat("browser-b").data
  assert.equal(paused.contentStamp, 1000 + (leftAt - started) * 1.2)
  assert.equal(paused.operator, "")
})

test("one of two people leaving does not pause the other", () => {
  const { session, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  session.setPlayer("browser-a", now(), {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 50,
  })
  assert.equal(session.leave("browser-a").code, "0000")
  const rest = session.heartbeat("browser-b")
  assert.equal(rest.data.playStatus, "PLAYING")
  assert.equal(rest.data.participants.length, 1)
  assert.equal(session.enter("browser-c").code, "0000")
})

test("while playing, the sweeper drops silent participants after the presence window and keeps the episode", () => {
  const { session, advance, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  session.setPlayer("browser-a", now(), {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 10,
  })
  advance(PRESENCE_TTL_MS - 1)
  assert.deepEqual(session.cleanupPlaying(), [])
  assert.equal(session.participantCount(), 2)

  advance(1)
  const removed = session.cleanupPlaying()
  assert.deepEqual(removed.sort(), ["browser-a", "browser-b"])
  assert.equal(session.participantCount(), 0)
  assert.equal(session.roomStatus().playStatus, "PAUSED")
  assert.equal(session.hasContent(), true)
  assert.equal(session.enter("browser-c").data.content.audioUrl, EPISODE.audioUrl)
})

test("a playing sweeper keeps someone whose heartbeat is still fresh", () => {
  const { session, advance, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  session.setPlayer("browser-b", now(), {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 10,
  })
  advance(PRESENCE_TTL_MS - 1000)
  session.heartbeat("browser-a")
  advance(2000)
  const removed = session.cleanupPlaying()
  assert.deepEqual(removed, ["browser-b"])
  assert.equal(session.participantCount(), 1)
  assert.equal(session.roomStatus().playStatus, "PLAYING")
})

test("a brand new session does not see another session's episode or participants", () => {
  const { session } = clocked()
  session.enter("browser-a")
  session.setContent("browser-a", EPISODE)
  const fresh = createSession()
  assert.equal(fresh.hasContent(), false)
  assert.equal(fresh.participantCount(), 0)
  assert.equal(fresh.enter("browser-a").data.content, null)
})

test("heartbeat and player control require a live slot", () => {
  const { session, now } = clocked()
  assert.equal(session.heartbeat("missing").errMsg, "NOT_IN_SESSION")
  assert.equal(session.leave("missing").errMsg, "NOT_IN_SESSION")
  assert.equal(session.setContent("missing", EPISODE).errMsg, "NOT_IN_SESSION")
  assert.equal(session.setPlayer("missing", now(), {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 0,
  }).errMsg, "NOT_IN_SESSION")
  assert.equal(session.hasContent(), false)
})

test("invalid player commands do not move an episode that is already loaded", () => {
  const { session, now } = clocked()
  session.enter("browser-a")
  session.setContent("browser-a", EPISODE)
  const stamp = now()
  session.setPlayer("browser-a", stamp, {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 100,
  })
  assert.equal(session.setPlayer("browser-a", stamp + 1000, {
    playStatus: "PLAYING",
    speedRate: "2",
    contentStamp: 5,
  }).ignore, "BAD_SPEED")
  assert.equal(session.setPlayer("browser-a", stamp + 1000, {
    playStatus: "MUTED",
    speedRate: "1",
    contentStamp: 5,
  }).ignore, "BAD_PLAYER")
  assert.equal(session.setPlayer("browser-a", stamp + 1000, {
    playStatus: "PAUSED",
    speedRate: "1",
    contentStamp: -1,
  }).ignore, "BAD_POSITION")
  assert.equal(session.roomStatus().contentStamp, 100)
  assert.equal(session.roomStatus().playStatus, "PLAYING")
})

const MINUTE = 60_000

test("either participant can set, change, or cancel a sleep timer", () => {
  const { session, now, advance } = clocked()
  const a = session.enter("browser-a")
  const b = session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-a", started, {
    playStatus: "PLAYING",
    speedRate: "1.7",
    contentStamp: 1000,
  })

  assert.equal(session.setSleep("browser-c", 15).errMsg, "NOT_IN_SESSION")
  for (const bad of [10, 15.5, "30", null, undefined, true, 90, -15, 15.0 + 0.1]) {
    assert.equal(session.setSleep("browser-a", bad).errMsg, "BAD_SLEEP", String(bad))
  }
  assert.equal(session.roomStatus().sleepEndStamp, null)
  assert.equal(session.roomStatus().playStatus, "PLAYING")
  assert.equal(session.roomStatus().contentStamp, 1000)

  const set = session.setSleep("browser-a", 15)
  assert.equal(set.code, "0000")
  assert.equal(set.data.guestId, a.data.guestId)
  assert.equal(set.data.sleepMinutes, 15)
  assert.equal(set.data.sleepEndStamp, started + 15 * MINUTE)
  assert.equal(set.data.playStatus, "PLAYING")
  assert.equal(set.data.speedRate, "1.7")
  assert.equal(set.data.contentStamp, 1000)
  assert.equal(set.data.operator, a.data.guestId)
  assert.equal(session.sleepDelay(), 15 * MINUTE)

  advance(1000)
  assert.equal(session.sleepDelay(), 15 * MINUTE - 1000)
  const restarted = session.setSleep("browser-a", 15)
  assert.equal(restarted.data.sleepEndStamp, now() + 15 * MINUTE)

  advance(5 * MINUTE)
  const changed = session.setSleep("browser-b", 45)
  const end45 = now() + 45 * MINUTE
  assert.equal(changed.data.guestId, b.data.guestId)
  assert.equal(changed.data.sleepMinutes, 45)
  assert.equal(changed.data.sleepEndStamp, end45)
  assert.equal(changed.data.playStatus, "PLAYING")
  assert.equal(session.heartbeat("browser-a").data.sleepEndStamp, end45)
  assert.equal(session.heartbeat("browser-a").data.sleepMinutes, 45)

  const cancelled = session.setSleep("browser-a", 0)
  assert.equal(cancelled.code, "0000")
  assert.equal(cancelled.data.sleepMinutes, null)
  assert.equal(cancelled.data.sleepEndStamp, null)
  assert.equal(cancelled.data.playStatus, "PLAYING")
  assert.equal(cancelled.data.contentStamp, 1000)
  assert.equal(session.sleepDelay(), null)
  assert.equal(session.setSleep("browser-b", 0).data.sleepEndStamp, null)
})

test("the deadline is wall-clock and pauses both seats at the current progress", () => {
  const { session, at, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-b", started, {
    playStatus: "PLAYING",
    speedRate: "1.5",
    contentStamp: 2000,
  })
  session.setSleep("browser-a", 30)
  const deadline = started + 30 * MINUTE
  assert.equal(session.roomStatus().sleepEndStamp, deadline)

  at(deadline - 1)
  assert.equal(session.takeDueSleep(), null)
  assert.equal(session.roomStatus().playStatus, "PLAYING")
  assert.equal(session.sleepDelay(), 1)

  at(deadline)
  const paused = session.takeDueSleep()
  assert.equal(paused.playStatus, "PAUSED")
  assert.equal(paused.contentStamp, 2000 + 30 * MINUTE * 1.5)
  assert.equal(paused.operateStamp, deadline)
  assert.equal(paused.operator, "")
  assert.equal(paused.speedRate, "1.5")
  assert.equal(paused.sleepMinutes, null)
  assert.equal(paused.sleepEndStamp, null)
  assert.equal(session.takeDueSleep(), null)
  assert.equal(session.participantCount(), 2)
  assert.equal(session.hasContent(), true)

  const seen = session.heartbeat("browser-a")
  assert.equal(seen.data.playStatus, "PAUSED")
  assert.equal(seen.data.contentStamp, 2000 + 30 * MINUTE * 1.5)
  assert.equal(seen.data.content.audioUrl, EPISODE.audioUrl)
  assert.equal(seen.data.participants.length, 2)
  assert.equal(session.heartbeat("browser-b").data.playStatus, "PAUSED")
})

test("the same wall-clock deadline lands further along at a faster rate", () => {
  function finish(rate) {
    const { session, at, now } = clocked()
    session.enter("browser-a")
    session.setContent("browser-a", EPISODE)
    const started = now()
    session.setPlayer("browser-a", started, {
      playStatus: "PLAYING",
      speedRate: rate,
      contentStamp: 0,
    })
    session.setSleep("browser-a", 15)
    at(started + 15 * MINUTE)
    return session.takeDueSleep()
  }

  const slow = finish("0.8")
  const fast = finish("1.7")
  assert.equal(slow.contentStamp, 15 * MINUTE * 0.8)
  assert.equal(fast.contentStamp, 15 * MINUTE * 1.7)
  assert.equal(slow.operateStamp, fast.operateStamp)
  assert.notEqual(slow.contentStamp, fast.contentStamp)
})

test("a seek or rate change keeps the deadline and the pause uses the latest anchor", () => {
  const { session, at, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-a", started, {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 0,
  })
  session.setSleep("browser-a", 60)
  const deadline = started + 60 * MINUTE
  const soughtAt = started + 10 * MINUTE
  at(soughtAt)
  const sought = session.setPlayer("browser-b", soughtAt, {
    playStatus: "PLAYING",
    speedRate: "0.8",
    contentStamp: 50000,
  })
  assert.equal(sought.roomStatus.sleepEndStamp, deadline)
  assert.equal(sought.roomStatus.sleepMinutes, 60)
  at(deadline)
  const paused = session.takeDueSleep()
  assert.equal(paused.contentStamp, 50000 + 50 * MINUTE * 0.8)
  assert.equal(paused.speedRate, "0.8")
  assert.equal(paused.playStatus, "PAUSED")
  assert.equal(session.hasContent(), true)
})

test("a timer that elapses while already paused clears without moving the playhead", () => {
  const { session, at, now } = clocked()
  const joined = session.enter("browser-a")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-a", started, {
    playStatus: "PAUSED",
    speedRate: "1.2",
    contentStamp: 42000,
  })
  session.setSleep("browser-a", 15)
  at(started + 15 * MINUTE)
  const paused = session.takeDueSleep()
  assert.equal(paused.playStatus, "PAUSED")
  assert.equal(paused.contentStamp, 42000)
  assert.equal(paused.operateStamp, started)
  assert.equal(paused.operator, joined.data.guestId)
  assert.equal(paused.speedRate, "1.2")
  assert.equal(paused.sleepEndStamp, null)
  assert.equal(paused.sleepMinutes, null)
})

test("changing the episode resets playback and keeps the sleep deadline", () => {
  const { session, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-a", started, {
    playStatus: "PLAYING",
    speedRate: "1.7",
    contentStamp: 8000,
  })
  session.setSleep("browser-b", 30)
  const deadline = started + 30 * MINUTE
  const replaced = session.setContent("browser-a", {
    ...EPISODE,
    audioUrl: "https://media.xyzcdn.net/next.m4a",
    title: "下一集",
  })
  assert.equal(replaced.data.playStatus, "PAUSED")
  assert.equal(replaced.data.speedRate, "1")
  assert.equal(replaced.data.contentStamp, 0)
  assert.equal(replaced.data.operator, "")
  assert.equal(replaced.data.content.title, "下一集")
  assert.equal(replaced.data.sleepMinutes, 30)
  assert.equal(replaced.data.sleepEndStamp, deadline)
  assert.equal(session.heartbeat("browser-b").data.sleepEndStamp, deadline)
  assert.equal(session.hasContent(), true)
})

test("while a sleep timer is armed, missed heartbeats do not drop seats or freeze playback", () => {
  const { session, advance, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-a", started, {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 0,
  })
  session.setSleep("browser-a", 15)
  advance(PRESENCE_TTL_MS + 5000)
  assert.deepEqual(session.cleanupPlaying(), [])
  assert.equal(session.participantCount(), 2)
  assert.equal(session.roomStatus().playStatus, "PLAYING")
  assert.equal(session.enter("browser-c").errMsg, "SESSION_FULL")
  const beat = session.heartbeat("browser-a")
  assert.equal(beat.data.participants.length, 2)
  assert.equal(beat.data.playStatus, "PLAYING")
  assert.equal(beat.data.sleepMinutes, 15)
})

test("after the timer fires, presence expiry works again", () => {
  const { session, at, advance, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-a", started, {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 10,
  })
  session.setSleep("browser-a", 15)
  const deadline = started + 15 * MINUTE
  at(deadline)
  const paused = session.takeDueSleep()
  assert.equal(paused.playStatus, "PAUSED")
  assert.equal(paused.contentStamp, 10 + 15 * MINUTE)
  advance(PRESENCE_TTL_MS)
  const beat = session.heartbeat("browser-a")
  assert.equal(beat.data.participants.length, 1)
  assert.equal(beat.data.participants[0].guestId, beat.data.guestId)
  assert.equal(beat.data.playStatus, "PAUSED")
  assert.equal(beat.data.content.audioUrl, EPISODE.audioUrl)
  assert.equal(session.hasContent(), true)
})

test("cancelling the timer restores presence expiry without rewinding playback", () => {
  const { session, advance, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-a", started, {
    playStatus: "PLAYING",
    speedRate: "1",
    contentStamp: 0,
  })
  session.setSleep("browser-a", 30)
  advance(5 * MINUTE)
  const cancelled = session.setSleep("browser-b", 0)
  assert.equal(cancelled.data.sleepEndStamp, null)
  assert.equal(cancelled.data.playStatus, "PLAYING")
  assert.equal(cancelled.data.contentStamp, 0)
  assert.equal(cancelled.data.operateStamp, started)
  const removed = session.cleanupPlaying()
  assert.deepEqual(removed, ["browser-a"])
  assert.equal(session.participantCount(), 1)
  assert.equal(session.roomStatus().playStatus, "PLAYING")
  assert.equal(session.roomStatus().contentStamp, 0)
})

test("explicit leave during a sleep timer still frees that seat and keeps the deadline", () => {
  const { session, at, now } = clocked()
  session.enter("browser-a")
  session.enter("browser-b")
  session.setContent("browser-a", EPISODE)
  const started = now()
  session.setPlayer("browser-a", started, {
    playStatus: "PLAYING",
    speedRate: "1.2",
    contentStamp: 1000,
  })
  session.heartbeat("browser-a")
  session.heartbeat("browser-b")
  session.setSleep("browser-a", 15)
  const deadline = started + 15 * MINUTE
  assert.equal(session.leave("browser-a").code, "0000")
  const rest = session.heartbeat("browser-b")
  assert.equal(rest.data.playStatus, "PLAYING")
  assert.equal(rest.data.participants.length, 1)
  assert.equal(rest.data.sleepEndStamp, deadline)
  assert.equal(session.enter("browser-c").code, "0000")

  const alone = clocked()
  alone.session.enter("browser-a")
  alone.session.setContent("browser-a", EPISODE)
  const began = alone.now()
  alone.session.setPlayer("browser-a", began, {
    playStatus: "PLAYING",
    speedRate: "1.2",
    contentStamp: 1000,
  })
  alone.session.heartbeat("browser-a")
  alone.session.setSleep("browser-a", 15)
  const ends = began + 15 * MINUTE
  alone.advance(4000)
  alone.session.heartbeat("browser-a")
  const leftAt = alone.now()
  assert.equal(alone.session.leave("browser-a").code, "0000")
  const frozen = alone.session.roomStatus()
  assert.equal(frozen.playStatus, "PAUSED")
  assert.equal(frozen.contentStamp, 1000 + (leftAt - began) * 1.2)
  assert.equal(frozen.sleepEndStamp, ends)
  assert.equal(alone.session.participantCount(), 0)
  assert.equal(alone.session.hasContent(), true)
  alone.at(ends)
  const done = alone.session.takeDueSleep()
  assert.equal(done.contentStamp, frozen.contentStamp)
  assert.equal(done.playStatus, "PAUSED")
  assert.equal(done.sleepEndStamp, null)
  assert.equal(alone.session.hasContent(), true)
})

test("a sleep timer can be set before an episode, and firing does not invent one", () => {
  const { session, at, now } = clocked()
  session.enter("browser-a")
  const started = now()
  const set = session.setSleep("browser-a", 60)
  assert.equal(set.data.sleepEndStamp, started + 60 * MINUTE)
  assert.equal(set.data.content, null)
  at(started + 60 * MINUTE)
  const paused = session.takeDueSleep()
  assert.equal(paused.playStatus, "PAUSED")
  assert.equal(paused.sleepEndStamp, null)
  assert.equal(session.hasContent(), false)
  assert.equal(session.participantCount(), 1)
})
