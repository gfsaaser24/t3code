# Turbo performance plan — 2026-08-09 (plain-language edition)

Four read-only audits (server, web app, relay, shared client code) at turbo tip `4b2bd877`.
Nothing here is implemented yet. Each item explains what happens today, what we would change,
and what you'd actually notice. File references stay so the item is executable later.

**Ownership legend:** *fork* = our code, change freely. *upstream* = Theo's code — either we
register a seam so our change survives the nightly sync, or (often better) we PR the fix
upstream: small perf fixes are what they accept, we're vouched now, and the fix flows back to
us automatically.

---

## The four big problems, explained simply

1. **The app re-does ALL of its homework every time one new word arrives.** When the agent
   streams text, both the server and the browser re-read, re-sort, or re-color *everything in
   the conversation* for every little update — instead of just handling the new bit. Short
   chats hide it; long sessions crawl. This is why the app "gets slower the longer you use it."
2. **Terminal output is handled like re-photocopying a book to add one page.** Every burst of
   build output makes both the server and the browser rebuild the *entire* scrollback from
   scratch. This is why a noisy `pnpm install` or test run makes everything stutter.
3. **The relay makes long-distance calls it doesn't need to make.** The relay runs on
   Cloudflare's edge but its database is one box in Germany — every question it asks the
   database is an intercontinental round trip. It currently asks several questions per request
   whose answers it either throws away (they feed the push-notification system we have
   *disabled*) or could remember for a few seconds.
4. **Every tiny update gets VIP treatment.** Each streamed word takes its own full trip through
   locks, state updates, and a React re-render. Grouping updates per screen-frame (~60/sec)
   would make one trip carry dozens of words at no visible cost.

---

## Server (`apps/server`) — mostly upstream-owned

### S1 — Stop re-reading the whole conversation to update four numbers ⭐ biggest server win
- **Today:** every time anything about a thread changes (which is constantly during a turn),
  the server loads *every message, activity, plan, and approval in that thread* — thousands of
  rows — just to recompute four small numbers for the sidebar (like "when was the last user
  message" and "how many approvals are pending"). The code that was built to batch this is
  accidentally never used (`ProjectionPipeline.ts:562-616, 1666-1676`).
- **Change:** ask the database for just the four numbers (`SELECT MAX(...)`, `SELECT
  COUNT(...)`) instead of loading everything and counting by hand; also actually plug in the
  batching code.
- **Outcome:** long-running threads stop getting slower over time. The "it was snappy this
  morning, now it's sluggish" effect largely disappears.

### S2 — Stop rebuilding the terminal scrollback per output burst ⭐ the "noisy build" fix
- **Today:** every chunk of terminal output (hundreds per second during a build) makes the
  server take its ~5,000-line scrollback, split it into 5,000 pieces, glue it back together,
  and also queue the *entire* scrollback for saving — every single chunk
  (`terminal/Manager.ts:855-865, 1717-1770`).
- **Change:** keep the scrollback as a list of lines and just append; collect output for ~16 ms
  before processing; save periodically instead of per chunk.
- **Outcome:** running builds/tests in the terminal no longer stalls the whole app.

### S3 — Stop doing 9 bookkeeping writes per event when ~8 are no-ops
- **Today:** each event is offered to all 9 "projector" components in its own mini-transaction
  with its own progress-marker write — even though most projectors ignore most events. A
  300-event turn does ~2,700 pointless writes (`ProjectionPipeline.ts:1626-1685`).
- **Change:** keep a simple map of "which projector cares about which event type," skip the
  rest, batch the progress markers.
- **Outcome:** every agent turn commits noticeably faster; less disk wear.

### S4 — One-line database tuning ⭐ best effort-to-reward in the whole plan
- **Today:** the SQLite database flushes to physical disk on *every* commit (the slowest, most
  paranoid mode), because only one of the recommended settings was applied
  (`persistence/Layers/Sqlite.ts:33-40`).
- **Change:** add the standard pragma set (`synchronous=NORMAL`, `busy_timeout`, `cache_size`,
  `temp_store=MEMORY`) — the textbook pairing with the WAL mode already in use. Safe: an app
  crash loses nothing; only an OS-level crash could lose the last moment of writes.
- **Outcome:** every single database commit gets faster, which speeds up literally everything
  the server does. One line.

### S5 — Stop loading the whole thread to answer small questions
- **Today:** several times per turn, ingestion loads the *entire* thread just to check things
  like "does this turn already have an assistant message?"
  (`ProviderRuntimeIngestion.ts:931-935`, `ProjectionSnapshotQuery.ts:2370-2523`).
- **Change:** add tiny targeted lookups (one already exists) for those specific questions.
- **Outcome:** same as S1 — cost stops growing with conversation length.

### S6 — Compute sidebar updates once, not once per connected device
- **Today:** if you have the desktop app, a browser tab, and your phone connected, the server
  runs the *same* sidebar-refresh queries three separate times, up to every 50 ms each
  (`ws.ts:604-718`).
- **Change:** compute the refresh once and broadcast the result to all listeners.
- **Outcome:** multi-device use stops multiplying server load; phone + desktop stays smooth.

### S7 — Don't send unbounded snapshots
- **Today:** connecting sends *every non-archived thread* in one giant message (no limit), and
  older clients get entire threads with no pagination (`ProjectionSnapshotQuery.ts:443-470`,
  `ws.ts:1391-1399`).
- **Change:** page the thread list; give the "full thread" fallback a sane default limit.
- **Outcome:** faster connect/reconnect, especially over the tunnel or on mobile.

### S8/S9 — Make checkpoints and diffs lazier
- **Today:** every turn end spawns ~9 git subprocesses and computes a full diff even if you
  never open the diff view; every diff view request re-runs git from scratch, even though
  checkpoints never change. A cache table for exactly this exists but is unused by the live
  path (`GitVcsDriver.ts:655-741`, `CheckpointDiffQuery.ts:167-265`).
- **Change:** use `git diff --name-status` for the summary, cache computed diffs (they're
  immutable), reuse repeated git lookups.
- **Outcome:** snappier turn completion; diff panel opens instantly the second time.

---

## Web app (`apps/web`) — mostly upstream; orbs are ours

### W1 — Stop re-coloring the entire code block on every streamed word ⭐ biggest streaming win
- **Today:** while the agent streams a code block, syntax highlighting re-processes the *whole
  block from the top* on every update, on the main thread, during render — the cache is
  explicitly bypassed while streaming (`ChatMarkdown.tsx:670, 705-730`). A 400-line block gets
  ~60,000 lines of cumulative re-highlighting while you watch.
- **Change:** show streaming code as plain text (or highlight only the visible tail), then
  highlight once when the block finishes.
- **Outcome:** the most visible streaming jank disappears exactly when you're watching most
  closely.

### W2+W3 — Sort the activity list once, not six times per event ⭐ easiest big win
- **Today:** every tool-progress update re-sorts the thread's *entire* activity list in the
  store — and then five view-layer functions each defensively copy and re-sort the *same
  already-sorted list again* (`threadReducer.ts:563-592`; `session-logic.ts:390, 496, 586,
  619, 748`). Six full sorts of the same data, per event, tens of times per second.
- **Change:** delete the five redundant sorts (the data is already sorted); in the store,
  insert the new item in its place instead of re-sorting everything.
- **Outcome:** busy turns with lots of tool calls stop bogging down the UI. The deletion half
  is zero-risk — it's removing work, not changing behavior.

### W4 — Use cheap string comparison for timestamps
- **Today:** the timeline re-sorts using `localeCompare` — a heavyweight
  international-text-collation routine — on ISO timestamps, which sort identically with plain
  `<`/`>` at 10–30× less cost (`session-logic.ts:1573-1606`). ~22,000 collation calls per
  streamed word on a big thread.
- **Change:** plain string comparison. (One legit `localeCompare` for filenames stays.)
- **Outcome:** another chunk of per-word streaming cost gone. A few characters of diff.

### W6 — Calm the `ultrathink` glow ⭐ the GPU fix
- **Today:** when an ultrathink model is selected, four infinite animations repaint the
  composer every screen refresh — 165 times/sec on a high-refresh display — even while the app
  sits idle, using repaint-expensive properties (moving gradients, hue-rotate filters, text
  masks) (`index.css:2091-2176`). The maintainers already solved this exact problem for status
  dots by stepping animations down to a few frames/sec; this styling just never got that
  treatment. Also: the app's reduced-motion accessibility rule covers only one minor animation.
- **Change:** add the same `steps()` treatment (a slow rainbow at 3 fps looks the same), and
  add the infinite animations to the reduced-motion rule.
- **Outcome:** GPU usage at idle drops to near zero with the composer open; laptop fans and
  battery thank you. Visually indistinguishable.

### W7 — Tell the thinking orbs what theme we're in *(fork-owned — ours)*
- **Today:** we never pass a `theme` prop to our thinking orbs, so each orb watches the *entire
  document* for class changes to guess the theme itself. Chat apps mutate classes constantly,
  so every orb wakes up on every hover, toggle, and streaming update anywhere on the page
  (`turbo/orbs/TimelineOrb.tsx:38, 68`). Passing the theme makes the library skip the watcher
  entirely.
- **Change:** pass the theme we already know (~3 lines).
- **Outcome:** an invisible tax on every UI interaction disappears. Cheapest fix in the plan.

### W8 — Cap the orb animation rate
- **Today:** each visible orb runs its own animation loop drawing ~300 tiny circles per frame,
  uncapped — 6–10 concurrent tool rows means 6–10 loops racing your refresh rate.
- **Change:** cap orbs to ~30 fps (they're ambient decoration) or animate only one per group.
- **Outcome:** smooth streaming even during big parallel-agent fan-outs.

### W9+W10 — Make the sidebar stop reacting to everything
- **Today:** any change to any thread (which happens constantly during a turn) rebuilds the
  whole thread array, which invalidates ~28 cached computations in the sidebar and re-sorts
  the full list — with the sort recomputing `Date.parse` tens of thousands of times per pass
  (`shellReducer.ts:31-36`, `Sidebar.logic.ts:552-585`).
- **Change:** store threads in a keyed map and patch one entry; precompute sort keys once per
  sort (a standard "decorate-sort-undecorate").
- **Outcome:** streaming in one thread stops making the *rest* of the app work.

### W11 — Split the 5.3 MB bundle ⭐ the cold-start fix
- **Today:** the web app ships one 5.27 MB JavaScript file parsed before first paint —
  including all 11 settings pages, the usage page, auth, the terminal engine, and the editor,
  even for someone who only opens a chat (`vite.config.ts:259-263`; zero of 23 route files are
  lazy). There's also an unexplained 975 KB "textarea" chunk worth investigating.
- **Change:** lazy-load the settings/usage routes (mechanical), load the terminal engine on
  first terminal open, split auth into its own cached chunk.
- **Outcome:** the app appears seconds faster on first load and after updates — the single
  most noticeable change for the hosted app at app.t3turbo.pro.

---

## Relay (`infra/relay`) — good news: it's a control plane; your actual traffic already skips it

### R1 — Stop doing database work for the push system we disabled ⭐ biggest relay win
- **Today:** the relay's busiest endpoint (called on every agent phase change) makes 4 + 2-per-
  user sequential Germany round trips — and most of them exist only to prepare push
  notifications for the APNs layer that this fork permanently stubs to "do nothing"
  (`AgentActivityPublisher.ts:56-172`). The answers are computed, then discarded.
- **Change:** provide a "store the record, skip the delivery prep" version of that component,
  wired from our fork-owned `worker.ts` — the same pattern the fork already uses to disable
  APNs. No upstream edit needed.
- **Outcome:** the hottest relay call gets roughly twice as fast and the database sees a third
  of the load.

### R5 — Fix the backwards timeouts ⭐ one-line bug fix
- **Today:** the relay gives your home server 10 seconds to answer, but gives *itself* only 9
  seconds total — so when your server is off, the helpful "your environment is offline" answer
  can never be produced; you always get a generic 504 error at 9 s (`Api.ts:167` vs
  `EnvironmentConnector.ts:129`).
- **Change:** lower the inner timeout to ~6–7 s.
- **Outcome:** a dead environment shows a fast, meaningful "offline" instead of a slow shrug.

### R3 — Stop phoning Clerk on every CLI request
- **Today:** every CLI request first tries the wrong token check (wasted), then calls Clerk's
  API over the internet to verify — with no caching, and rebuilding the Clerk client each
  request (`Api.ts:1167-1227`).
- **Change:** detect the token type up front, build the client once, and remember successful
  verifications for ~30–60 s (bounded by the token's own lifetime).
- **Outcome:** `t3 connect` and CLI operations feel noticeably snappier.

### R4 — Remember nearly-static answers for a few seconds
- **Today:** "which environment is linked to this user" and similar lookups — which only
  change when you link/unlink — are re-asked of the Germany database on every request, because
  the generic Hyperdrive cache is (correctly) off (`db.ts`, `environments/*`).
- **Change:** cache exactly those lookups in the Worker for 5–15 s, purging on the three
  writes that can change them. Built as wrapper layers from fork-owned `worker.ts`.
- **Outcome:** connect/status checks go from two long-distance calls to usually zero.

### R2 — Move replay protection to the edge (bigger job, biggest ceiling)
- **Today:** every authenticated request writes a "seen this request before?" note to the
  Germany database *before doing anything else* — even for pure reads
  (`auth/DpopProofs.ts:53-81`).
- **Change:** keep those notes in a Cloudflare Durable Object (edge-local, exactly the right
  consistency model). More work; needs careful expiry handling.
- **Outcome:** removes a long-distance round trip from *every* mobile/CLI request — the
  biggest possible relay latency cut, saved for last because it's the most involved.

**Relay footgun to respect** (`agentActivity/Devices.ts:84-88`): never hand a raw drizzle
query object to `Effect.all` — it pegs the Worker at 100 % CPU. Some sequential-looking code
is sequential *on purpose* because of this.

---

## Shared client code (`packages/client-runtime`, `packages/contracts`)

### C1 — Stop re-measuring the whole terminal buffer per frame ⭐ client twin of S2
- **Today:** every terminal output frame re-encodes the entire 512 KB scrollback to bytes just
  to check "are we over the limit yet?" — ~100 MB/s of throwaway work during a build
  (`terminalSession.ts:65-141`).
- **Change:** keep a running byte count, only do the expensive trim when actually over the cap,
  and group frames before updating state.
- **Outcome:** terminals stay smooth during heavy output, especially on mobile.

### C2 — Group streamed words per screen-frame ⭐ multiplies every other client fix
- **Today:** each streamed word individually takes a lock, updates state ~6 times, and triggers
  a React render — ~30 renders/sec (`threads.ts:255-292, 402-406`).
- **Change:** collect events for ~16 ms and apply the batch in one pass
  (`Stream.groupedWithin`) — same ordering guarantees, one render per frame.
- **Outcome:** streaming cost drops 3–5× across the board in one contained change.

### C6-check — Verify mobile actually compresses its connection ⭐ 5-minute check, huge if true
- **Today:** our own measurements show a turn is 68 KB of raw data squeezed to 8 KB by
  websocket compression — *in browsers*. React Native's WebSocket often doesn't negotiate that
  compression. If it doesn't, the mobile app is paying 68 KB where web pays 8.
- **Change:** check one header on a real device; if missing, enable/polyfill compression.
- **Outcome:** potentially an 8× mobile data reduction for zero design work.

### C3/C5/C8/C9 — Assorted efficiency fixes (client-only, no wire changes)
- Patch one thread in a keyed map instead of rebuilding all-threads arrays per update
  (`shellReducer.ts:31-36`) → sidebar stops churning during turns.
- Don't re-save the full app snapshot to cache twice a second during activity — the thread
  path already has a "don't save while hot" guard; give the shell/config paths the same
  (`shell.ts:94-178`) → less main-thread stalling mid-turn.
- On app foreground, don't tear down and rebuild all 15–25 subscriptions when the connection
  probe already said the socket is fine (`wakeups.ts:19-21`) → faster app resume, less battery.
- Let reconnect backoff grow past 16 s with jitter when a server stays unreachable
  (`supervisor.ts:32`) → phone stops waking its radio every 16 s all night for a laptop
  that's asleep.

### C4 — Make message decoding cheaper everywhere (wire-format unchanged)
- **Today:** every string field in every message allocates a tiny Effect wrapper to run
  `.trim()` (thousands per snapshot), and one helper decodes every array element *twice*
  (`baseSchemas.ts:6-46`).
- **Change:** two small local rewrites in one file; bytes on the wire are byte-identical.
- **Outcome:** every decode in the product (client *and* server share these schemas) gets
  cheaper. Benchmark before/after to size it.

### C6/C7 — Slim the per-word envelope (contract change, do last, measure first)
- **Today:** a 5-character streamed word ships in ~500–700 bytes of envelope (IDs, correlation
  fields, timestamps — mostly identical between consecutive deltas). Provider status updates
  re-send the *entire* provider catalogue (all models, commands, skills) for a one-field
  change.
- **Change:** compact delta events behind a capability flag — the codebase already has the
  exact pattern for safely rolling out wire changes (`threadSnapshotPagination`).
- **Outcome:** less bandwidth and less parse work on every surface; needs coordinated rollout,
  hence last.

---

## Order of attack

**Wave 1 — tiny changes, zero behavior risk, do immediately:**
S4 (database pragmas) · W3 (delete five redundant sorts) · W4 (cheap comparisons) · W7 (orb
theme prop) · W6 (calm the glow) · R5 (timeout constant) · C6-check (mobile compression).

**Wave 2 — contained fixes for the quadratic monsters and the relay hot path:**
W1 (no re-highlighting while streaming) · S2 + C1 (terminal, both sides) · C2 (frame batching)
· R1 (skip dead push work) · R3 (stop phoning Clerk).

**Wave 3 — bigger refactors, measure as we go:**
S1 (aggregate queries) · S3 (projector map) · W11 (bundle splitting) · C3/W9 (keyed stores) ·
C4 (decode cost) · S6 (shared fan-out) · R4 (edge caching) · C6/C7 (compact contracts) · R2
(Durable Object).

**Fork vs upstream:** fork-owned things (relay wiring, orbs, Turbo seams) we change directly.
Upstream-owned pure wins (S4, W3, W4, R5, C4) are prime candidates to PR to Theo — no seam
maintenance for us, and the fix comes back through the nightly sync.
