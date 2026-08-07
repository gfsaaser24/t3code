# Fix: silent loss of live background agents on Claude session teardown

Branch: `t3code/diagnose-agent-session-failures`
Status: implemented (post-review design). This file records the diagnosis, the
review outcome, and the final shape.

## Diagnosed defect (evidence in `~/.t3-turbo/userdata`)

Thread `7f98b23a-87de-4e9e-b5ad-69a29206b2a0` (worktree `lawn-app/t3code-8c19c27c`,
provider `claudeAgent`, SDK session `ed53b3eb`) repeatedly lost 4 running
background review agents:

- `17:46` — 4 `local_agent` background tasks start.
- `17:47:03` — turn completes, session `ready`, `activeTurnId=null`.
- `17:51:48` — SDK stream ends; `handleStreamExit` tears the session down
  (`thread.session-set status=stopped, lastError=null`). All 4 agents die with
  the child process. **Nothing is surfaced.**
- `17:51 → 18:36` — 44 minutes of silence; the UI still shows the agents as
  running.
- `18:36:11` — next user message resumes the session via
  `recoverSessionForThread`; only then does the SDK report all 4 tasks
  `status:"stopped"`. The same shape repeats at `19:03`.

Secondary defects: adapter-internal `session.exited` never marks the persisted
runtime binding `stopped` (ghost `running` rows); the reaper's only liveness
signal is `activeTurnId`, so sessions whose only live work is background agents
read as idle.

## Second confirmed incident: the reaper is a live killer, not just a latent one

While this fix was being written, the reaper killed the very session writing it
(thread `cbcc87a2`, worktree `t3code-0c5c8888`), orphaning a background test
run. Trace evidence (`server.trace.ndjson.3`, trace `876a00c3…`):

- Turn started ~`19:43Z` — `lastSeenAt` refreshes only at `sendTurn`.
- Turn completed `20:13Z`; a `local_bash` background task (full test suite)
  kept running.
- Sweep at `20:25:11Z`: binding read 42 min idle, `activeTurnId=null` →
  `stopSession` → `session.exited {reason:"Session stopped",exitKind:"graceful"}`
  at `20:25:17Z`. The trace shows the sweep body (directory reads →
  `resolveRoutableSession` → `stopSession` → MCP revoke → analytics) forked
  from the startup reactor phase, with no client command anywhere in it.

## Unified root cause (resolved by forensics, 2026-08-07)

Deeper digging closed the "unknown stream-end trigger" question: **there was
only ever one killer — the reaper.** All 13 `thread.session-set stopped`
events across three threads that day landed 30.1–39.7 minutes after the last
**user message** (verified per-stop against `projection_thread_messages`).
The lawn-app session at 17:51:48 was streaming four agents' tool calls two
seconds before its "graceful" exit — the process did not die on its own;
`stopSession` killed it.

The gap that made the reaper's 30-minute rule misfire during active work:
`lastSeenAt` only refreshed on user-initiated `sendTurn`. Turns the provider
starts by itself (background task notifications waking the agent) never route
through it, so a thread doing autonomous work reads as idle from the user's
last keystroke. Fixed by touching the binding on `turn.started` /
`turn.completed` in the event pump (same helper as the `session.exited`
binding sync).

Coverage: incident A (four `local_agent` fleets) and incident B (`local_bash`
suite) are both deferred by the liveness check, and the turn-activity
heartbeat keeps the clock honest between notifications.

## Review outcome (3 parallel reviewers)

All three reviewers rejected the originally proposed in-adapter auto-resume:
a clean stream end means the `claude` child process already exited, and
background agents are in-process — resume restores session continuity but
cannot revive tasks, so "preserving `liveTaskIds` across resume" preserves
bookkeeping for dead work and (combined with a reaper exemption keyed on that
set) manufactures unreapable zombie sessions. The existing
`recoverSessionForThread` path already resumes on the next message. The
machinery (retry/backoff, `resumeInFlight`, generation counters, prompt-queue
migration) died with the feature. Turn-accounting hardening (phantom
`turn.completed` on resume handshakes) was split to a follow-up PR.

## Shipped design

1. **Honest loss reporting** (`apps/server/src/provider/Layers/ClaudeAdapter.ts`)
   - `stopSessionInternal` drains `liveTaskIds` and emits a terminal
     `task.completed(status: "stopped")` per task (the `interruptTurn`
     pattern), so every teardown path — stream exit, user stop, session
     replace, stopAll — leaves zero phantom running agents.
   - `handleStreamExit` (both clean and failure exits, trigger-agnostic)
     additionally emits a `runtime.error` naming the lost agents and telling
     the user a new message resumes the session, plus a structured
     `claude.session.stream-ended-with-live-tasks` warning log (exit kind,
     task count/descriptions, session age, active-turn flag) so the upstream
     trigger — whatever ends the stream minutes after a turn settles — stays
     measurable in the field.

2. **Binding consistency** (`apps/server/src/provider/Layers/ProviderService.ts`)
   - The runtime-event pump (`processRuntimeEvent`) marks the persisted
     directory binding `stopped` whenever `session.exited` flows through, for
     every adapter. Best-effort: missing binding is a no-op; failures log and
     never break event delivery.

3. **Reaper background-work awareness**
   (`apps/server/src/provider/Layers/ProviderSessionReaper.ts`)
   - The sweep consults the existing `ThreadBackgroundLivenessService` (fed by
     ingestion, cleared on terminal task status / session exit / restart — a
     decaying signal, no new adapter API) and skips sessions with live
     background work, up to a wedge cap `backgroundWorkMaxIdleMs` (default 4h,
     floored at the inactivity threshold) so a task that never terminates
     cannot pin a session forever. Skips log at Info.

No contract changes; server-side only; nothing new crosses the wire, so web,
desktop, mobile, relay, and tunnel modes are unaffected.

## Follow-ups (not this PR)

- Phantom-turn accounting: `system/init` + `result(num_turns: 0, zero usage)`
  resume handshakes emit `turn.completed` and can complete a real active turn
  prematurely (observed at `19:03:51` and `19:20`). Needs its own PR and
  non-suppression tests.
- ~~Root-cause hunt for the stream-end trigger~~ Resolved: it was the reaper
  (see "Unified root cause"). The structured log stays as a tripwire for any
  genuinely spontaneous CLI exit.

## Tests

- `ClaudeAdapter.test.ts`: clean stream end with live tasks → `runtime.error`
  naming both agents + `task.completed(stopped)` per task + teardown; failure
  exit with a live task → same loss reporting.
- `ProviderService.test.ts`: `session.exited` through the pump marks the
  persisted binding `stopped`.
- `ProviderSessionReaper.test.ts`: idle-past-threshold session with live
  background work is skipped; past the wedge cap it is reaped.
