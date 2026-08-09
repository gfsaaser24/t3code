# Turbo speed plan — 2026-08-09

We audited all four parts of the stack — the server on your PC, the web app, the relay in the
cloud, and the shared client code — looking for places where Turbo does way more work than it
needs to. This document lists every finding in the same simple shape:

- **The problem** — what the app does today that wastes time, in plain words.
- **What we'd change** — the actual fix.
- **The perf gain** — what gets faster for you.

A ⭐ marks the best bang-for-buck items. The tiny grey file paths are for whoever implements
it — you can ignore them. Nothing here is built yet.

---

## The theme in one paragraph

Turbo mostly doesn't have "slow code" — it has code that **repeats work**. When one new word
streams in, the app re-processes the whole conversation. When one line of build output
arrives, it rebuilds the whole terminal history. When the relay answers one request, it makes
the same long-distance database calls it made last time and throws half the answers away. Fix
the repetition and the same hardware suddenly feels twice as fast — that's the whole plan.

---

# Part 1 — The server (runs on your PC)

### ⭐ S4. Turn on the database's "fast mode" — a one-line change
- **The problem:** the server's database is set to its most paranoid mode: after *every* tiny
  save, it waits for the disk to physically confirm the write. It does thousands of saves per
  agent turn, so it spends a lot of its life waiting on the disk for no real safety benefit
  (the standard "fast mode" is still crash-safe for app crashes).
- **What we'd change:** add one line of standard database settings that every SQLite guide
  recommends for exactly this setup.
- **The perf gain:** *everything* the server does — every message, every event, every save —
  gets a speed boost at once. Best single line of code in this plan.
- <sub>`apps/server/src/persistence/Layers/Sqlite.ts:33-40`</sub>

### ⭐ S1. Stop re-reading the whole chat to update four little numbers
- **The problem:** dozens of times per turn, the server needs to refresh four small numbers
  for the sidebar (things like "how many approvals are waiting"). To get them, it currently
  reloads **every message and activity in the entire thread** — thousands of rows — counts
  them by hand, and throws them away. The longer your chat, the more it reloads, every time.
  This is *the* reason long sessions feel like they slowly turn to mud.
- **What we'd change:** ask the database directly for the four numbers ("count the pending
  ones") instead of fetching everything and counting ourselves. Also plug in an existing
  batching feature that was built for this but is accidentally never switched on.
- **The perf gain:** chats stay just as fast at hour six as they were at minute one. The
  "Turbo got sluggish today" feeling largely disappears.
- <sub>`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:562-616, 1666-1676`</sub>

### ⭐ S2. Stop rebuilding the terminal's memory on every line of output
- **The problem:** picture keeping notes by re-photocopying your whole notebook every time you
  add one line. That's what the server does with terminal output: for every burst a running
  build produces (hundreds per second), it takes its ~5,000-line scrollback, chops it apart,
  glues it back together, and queues the *entire thing* to be saved. A noisy `pnpm install`
  can generate ~80 MB/s of this pure busywork.
- **What we'd change:** keep the scrollback as a simple list and just add new lines to the
  end; process output in little ~16 ms batches; save now and then instead of constantly.
- **The perf gain:** builds and test runs scroll by smoothly and the rest of the app stays
  responsive while they do. The "everything froze during a build" bug dies here.
- <sub>`apps/server/src/terminal/Manager.ts:855-865, 1717-1770`</sub>

### S3. Stop asking nine departments to file paperwork about every event
- **The problem:** every event that happens gets handed to all nine of the server's
  bookkeeping components, each opening its own mini-transaction and writing its own "I saw it"
  note — even though for any given event, about eight of the nine don't care. One agent turn
  can produce ~2,700 of these pointless notes.
- **What we'd change:** keep a simple list of which component cares about which kind of event,
  skip the rest, and write the notes in batches.
- **The perf gain:** agent turns commit noticeably faster and your disk does a fraction of
  the work.
- <sub>`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1626-1685`</sub>

### S5. Answer small questions with small lookups
- **The problem:** several times per turn the server asks itself things like "did this turn
  already produce a message?" — and answers by loading the *entire conversation* into memory
  to check.
- **What we'd change:** add tiny targeted lookups for those exact questions (one already
  exists and just isn't used here).
- **The perf gain:** turn processing stops costing more as conversations grow — same win as
  S1, from a second angle.
- <sub>`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:931-935`</sub>

### S6. Compute sidebar updates once, share with every device
- **The problem:** with your desktop app, a browser tab, and your phone connected, the server
  computes the exact same sidebar refresh **three separate times** — once per device — up to
  twenty times a second during activity.
- **What we'd change:** compute it once and hand the same result to everyone listening.
- **The perf gain:** using Turbo from multiple devices at once costs the same as using it
  from one. Phone + desktop stays buttery.
- <sub>`apps/server/src/ws.ts:604-718`</sub>

### S7. Send the first screen, not the whole filing cabinet
- **The problem:** when a device connects, the server sends *every thread you've ever had* in
  one giant message; older clients can also receive entire conversations at once with no
  limit.
- **What we'd change:** send a first page and fetch more on demand (the pagination machinery
  already exists — it just needs sane defaults).
- **The perf gain:** connecting and reconnecting gets much faster — most noticeable on your
  phone or over the tunnel.
- <sub>`apps/server/src/orchestration/ProjectionSnapshotQuery.ts:443-470`, `ws.ts:1391-1399`</sub>

### S8 + S9. Do checkpoint/diff work only when someone will look at it
- **The problem:** at the end of every turn the server runs ~9 git commands and computes a
  full diff — even if you never open the diff panel. And when you *do* open it, it recomputes
  from scratch every time, despite the answer never changing (checkpoints are frozen). A
  cache table built for exactly this sits unused.
- **What we'd change:** compute just the cheap file-name summary at turn end, compute full
  diffs on first view, and remember them (they can never go stale).
- **The perf gain:** turns wrap up quicker, and the diff panel opens instantly after the
  first view.
- <sub>`apps/server/src/vcs/GitVcsDriver.ts:655-741`, `checkpointing/CheckpointDiffQuery.ts:167-265`</sub>

---

# Part 2 — The web app (what you see)

### ⭐ W1. Don't render code blocks at all while they stream — blip them in complete
- **The problem:** while the agent streams a code block at you, the app re-renders the
  growing block on **every few characters**: re-parse the markdown, re-color the syntax
  **from the very top**, and re-layout the page — on the main thread, right in the middle of
  drawing. A 400-line block gets the equivalent of 60,000 lines of re-coloring before it
  finishes. It's the single most expensive thing happening while text streams.
- **What we'd change (scope decided 2026-08-09):** take the streaming code block out of the
  live render path entirely. While code is streaming, show only a small, fixed-size
  placeholder card — language name and a cheap ticking line count ("`typescript` · writing…
  142 lines") — and buffer the incoming text off-screen where it costs nothing. The moment
  the block completes, render and color it **once**, fully finished, and blip it into place.
  Deliberate trade-off: you don't watch code scroll by character-by-character — you get a
  calm progress card and then the finished block. (Prose keeps streaming normally; this is
  code fences only.)
- **The perf gain:** the per-word cost of code streaming drops to almost literally zero — no
  re-parsing, no re-coloring, no page reflow, just a counter ticking. Long code-heavy turns
  stop being the app's heaviest moment and become its lightest, and the finished block
  appears fully formatted in one clean pop. Kills the recolor bug *and* banks the biggest
  resource saving available in the web app.
- <sub>`apps/web/src/components/ChatMarkdown.tsx:670, 705-730` — placeholder replaces the
  streaming branch; buffered text renders once on `streaming → false`</sub>

### ⭐ W2 + W3. Sort the activity list once, not six times per update
- **The problem:** every tool-progress update re-sorts the thread's *entire* activity list —
  and then five other pieces of code each take that already-sorted list, copy it, and
  **re-sort it again just in case**. Six full sorts of identical data, per update, dozens of
  times per second. Half of this fix is literally deleting code.
- **What we'd change:** delete the five "just in case" re-sorts, and have the store slot each
  new activity into its correct position instead of re-sorting everything.
- **The perf gain:** busy turns with lots of tool calls keep the UI light and immediate. And
  we get it partly by *removing* code — the safest kind of change there is.
- <sub>`packages/client-runtime/src/state/threadReducer.ts:563-592`, `apps/web/src/session-logic.ts:390-748`</sub>

### W4. Compare timestamps the cheap way
- **The problem:** the timeline sorts by timestamp using a heavyweight routine built for
  comparing text across human languages and alphabets. Our timestamps are machine strings
  that plain "is A less than B" compares perfectly — 10–30× cheaper. Right now a single
  streamed word can trigger ~22,000 of the expensive comparisons.
- **What we'd change:** swap in the plain comparison. A few characters of code.
- **The perf gain:** another slice of per-word streaming cost gone, basically for free.
- <sub>`apps/web/src/session-logic.ts:1573-1606`</sub>

### W6. ~~Calm the ultrathink glow~~ — SKIPPED (operator decision 2026-08-09)
Leave the ultrathink glow exactly as it is. (Was: step its always-on animations down to a few
frames per second to cut idle GPU use.) Not doing it.

### W7. ~~Pass the theme to the thinking orbs~~ — SKIPPED (operator decision 2026-08-09)
Leave the orbs untouched. (Was: pass a `theme` prop so each orb stops watching the whole page
for theme changes.) Not doing it.

### W8. ~~Cap orb animation at 30 fps~~ — SKIPPED (operator decision 2026-08-09)
Leave the orbs at full frame rate. Not doing it.

### W9 + W10. Make the sidebar mind its own business
- **The problem:** while a thread streams, its bookkeeping fields change constantly — and
  each change makes the sidebar rebuild its entire world: re-derive ~28 cached computations
  and re-sort the full thread list, parsing thousands of dates from scratch *inside* the
  sort. All for threads you're not even looking at.
- **What we'd change:** store threads in a keyed map so one change touches one entry, and
  precompute each thread's sort key once before sorting.
- **The perf gain:** streaming in one chat no longer makes the rest of the app do push-ups.
  Big thread lists feel weightless.
- <sub>`packages/client-runtime/src/state/shellReducer.ts:31-36`, `apps/web/src/components/Sidebar.logic.ts:552-585`</sub>

### ⭐ W11. Don't make people download the settings pages to read a chat
- **The problem:** the web app ships as one 5.3 MB JavaScript file that must be downloaded
  and parsed **before anything appears** — including all 11 settings pages, the usage
  dashboard, the terminal engine, and the login system, even if you only came to read one
  chat. On a mid-range laptop that's seconds of staring at nothing.
- **What we'd change:** split it up so each part loads the first time you actually open it —
  the routing library supports this natively; it's mechanical work. (Also: find out why
  there's a 975 KB chunk named "textarea.")
- **The perf gain:** app.t3turbo.pro appears on screen seconds earlier, on every device,
  every visit after every update. The most noticeable cold-start win available.
- <sub>`apps/web/vite.config.ts:259-263`, `apps/web/src/routes/*`</sub>

---

# Part 3 — The relay (the cloud piece)

Good news first: your actual chat traffic **already bypasses the relay** — it flows straight
from your devices to your PC through the tunnel. The relay only handles logins, linking, and
status pings.

**Where the relay's database actually lives** (corrected — the first draft wrongly said
"Germany"): the relay code runs on Cloudflare's network, answering from whichever Cloudflare
location is closest to the device asking. Its database is the Supabase Postgres running on
your `openclaw` Hetzner server in **Ashburn, Virginia** — the same box that runs OpenClaw
(`178.156.253.60`, confirmed against your Hetzner account; ~10 ms from your desk on a clean
path). So every question the relay asks its database is a hop from Cloudflare to that one
Virginia box and back. Short from home; longer from a phone on the road hitting a distant
Cloudflare location. Either way the math is the same: **asking six questions when two will do
makes every request several times slower than it needs to be** — the game here is simply
"make fewer trips," and every gain below stands regardless of geography.

### ⭐ R1. Stop preparing push notifications we will never send
- **The problem:** the relay's busiest endpoint fires on every agent status change. Most of
  the database trips it makes exist to prepare **push notifications** — for the Apple push
  system this fork has permanently *disabled*. It gathers the data, hands it to a component
  whose job is "do nothing," and throws it all away. Every time.
- **What we'd change:** a "store the record, skip the notification prep" version of that
  component, plugged in from our own fork-owned wiring — same pattern we already use to
  disable Apple push. Zero upstream code touched.
- **The perf gain:** the relay's hottest call gets roughly **2× faster** and our database
  sees about a third of its current load.
- <sub>`infra/relay/src/agentActivity/AgentActivityPublisher.ts:56-172`, wired from `worker.ts`</sub>

### ⭐ R5. Fix the backwards timeouts — a one-line bug fix
- **The problem:** the relay gives your home server 10 seconds to answer, but gives *itself*
  only 9 seconds total. So the friendly "your environment is offline" message can literally
  never be shown — the 9-second timer always wins and you get a slow, generic error instead.
- **What we'd change:** set the inner timer to ~6–7 seconds. One constant.
- **The perf gain:** when your PC is off, your phone says "environment offline" quickly and
  clearly instead of hanging 9 seconds and shrugging.
- <sub>`infra/relay/src/http/Api.ts:167` vs `environments/EnvironmentConnector.ts:129`</sub>

### R3. Stop calling Clerk's servers on every single CLI request
- **The problem:** every CLI request makes the relay first try the *wrong* kind of token
  check (guaranteed to fail), then call Clerk's API **over the internet** to verify your
  token — with no memory of having just verified the same token one second ago. It even
  rebuilds its Clerk connection object from scratch each request.
- **What we'd change:** detect the token type up front, build the Clerk client once, and
  remember successful verifications for ~30–60 seconds.
- **The perf gain:** `t3 connect` and every CLI operation loses a full internet round trip —
  the difference between "instant" and "hmm."
- <sub>`infra/relay/src/http/Api.ts:1167-1227`</sub>

### R4. Remember answers that almost never change
- **The problem:** "which environment belongs to this user?" only changes when you link or
  unlink a device — maybe once a month. The relay asks the Virginia database this question
  fresh on **every request**.
- **What we'd change:** remember those answers inside the relay for 5–15 seconds, and forget
  them instantly on the three operations that can change them. Built in our own wiring layer.
- **The perf gain:** connection and status checks go from two database trips to usually
  **zero** — answered from the relay's own short-term memory.
- <sub>fork-owned layers over `infra/relay/src/environments/*`</sub>

### R2. ~~Move the replay-protection check to the edge~~ — SKIPPED (operator decision 2026-08-09)
Not touching this. (Was: move the per-request "have I seen this request before?" security
note from Postgres into a Cloudflare Durable Object.) It's the most invasive relay change and
touches security-critical code — staying away by choice.

> ⚠️ One booby trap for whoever implements relay changes: never hand a raw database query
> object to `Effect.all` — it locks the Worker at 100 % CPU. Some code here is sequential
> *on purpose* because of this. (`agentActivity/Devices.ts:84-88`)

---

# Part 4 — Shared client plumbing (web + mobile both benefit)

### ⭐ C1. Stop weighing the whole terminal buffer on every update
- **The problem:** the app keeps up to 512 KB of terminal scrollback, and on *every* output
  frame it re-measures **the entire buffer, byte by byte**, just to ask "am I over the limit
  yet?" During a build that's ~100 MB per second of measuring the same half-megabyte over
  and over.
- **What we'd change:** keep a running total (add the size of just the new bit), and only do
  real trimming work when actually over the limit.
- **The perf gain:** terminals stay smooth through the heaviest output — biggest single win
  for the phone app.
- <sub>`packages/client-runtime/src/state/terminalSession.ts:65-141`</sub>

### ⭐ C2. Pool incoming words and blip them onto the screen in batches
- **First, what this does NOT touch:** nothing about "streaming" as a technology changes.
  The agent connection, the wire protocol, the server — all untouched. Words arrive from the
  network exactly as they do today. This item is *only* about how often the **screen**
  processes what already arrived. It is exactly "pool responses and blip them in."
- **The problem:** today, every single arriving word is processed the instant it lands —
  each one takes a lock, updates state six times, and triggers a screen re-render. That's
  like a waiter making thirty separate kitchen trips for thirty fries. Your screen only
  refreshes 60–165 times a second anyway, so most of those individual updates were never
  even visible.
- **What we'd change:** pool whatever arrived and blip it in as one batch. The pooling
  window is a knob we choose: ~16 ms pools per screen-frame (text looks exactly as "live" as
  today), or coarser — say 100–250 ms — where text visibly arrives in small chunks and the
  app does even less work. Same words, same order, same result either way.
- **The perf gain:** cuts the cost of everything else that happens per word by 3–5× at the
  16 ms setting, more at coarser settings. This is the multiplier fix — it makes every other
  fix in this list count more.
- <sub>`packages/client-runtime/src/state/threads.ts:255-292, 402-406`</sub>

### ⭐ C6-check. Five minutes that might save mobile 8× its data
- **The problem:** we measured that one agent turn is ~68 KB of raw data that websocket
  compression squeezes to ~8 KB — *in browsers*. The phone app's networking layer often
  doesn't turn that compression on, and nobody has ever checked ours.
- **What we'd change:** check one connection header on a real phone. If compression is off,
  turn it on.
- **The perf gain:** if it's off (decent odds), the phone app instantly uses **~8× less
  data** and feels dramatically snappier on cellular. Best lottery ticket in the plan.
- <sub>`apps/server/integration/TransferBudgetReport.integration.ts:33-38` shows the 68 KB → 8 KB measurement</sub>

### C3 + C5 + C8 + C9. Four smaller kindnesses to your battery
- **The problem / change / gain, rapid-fire:**
  1. Any thread update rebuilds the full thread list in memory → patch one entry in a keyed
     map → sidebar data stops churning during turns.
  2. The app re-saves its entire state snapshot to disk cache twice a second during activity
     → skip saving while things are hot, save when they settle (the thread path already does
     this — copy its homework) → fewer mid-turn stutters.
  3. Bringing the app to the foreground tears down and rebuilds all 15–25 server
     subscriptions even when the connection was fine → only rebuild when the connection
     actually broke → the app snaps back instantly when you switch to it.
  4. When your PC is off, your phone retries the connection every 16 seconds *forever*, all
     night → let retries space out to minutes (with a dash of randomness so your devices
     don't all retry in unison) → your phone's radio sleeps; foregrounding the app still
     reconnects immediately.
- <sub>`shellReducer.ts:31-36` · `shell.ts:94-178` · `wakeups.ts:19-21` · `supervisor.ts:32`</sub>

### C4. Make unpacking messages cheaper everywhere at once
- **The problem:** two tiny inefficiencies in the *shared message-unpacking code* multiply
  across the whole product: every text field allocates a little wrapper object just to trim
  whitespace (thousands per screenful), and one helper unpacks every list element **twice**.
  Server and clients share this code, so everyone pays.
- **What we'd change:** two small rewrites in one file. The data on the wire stays
  byte-for-byte identical — zero compatibility risk.
- **The perf gain:** every message everyone sends or receives, on every surface, gets cheaper
  to process. Quiet, global, compounding.
- <sub>`packages/contracts/src/baseSchemas.ts:6-46`</sub>

### C6 + C7. Shrink the envelopes (careful, coordinated — do last)
- **The problem:** a 5-character streamed word ships inside ~600 bytes of addressing and
  bookkeeping — like mailing single fries in padded envelopes. Separately, when one
  provider's status flips one field, the server re-sends the *entire catalogue* of every
  provider, model, command, and skill.
- **What we'd change:** compact "delta" message types carrying only what changed, rolled out
  behind a compatibility flag (the codebase already has the exact pattern for doing this
  safely across old and new clients).
- **The perf gain:** less bandwidth and less parsing on every surface, every second of use —
  saved for last only because it needs server and clients updated in step.
- <sub>`packages/contracts/src/orchestration.ts:1221-1326`, `server.ts:485-533`</sub>

---

# The order we'd do it in

**Wave 1 — an afternoon of tiny, zero-risk changes:**
S4 (database fast mode) · W3 (delete the five re-sorts) · W4 (cheap comparisons) · R5
(timeout constant) · C6-check (phone compression). Each is a few lines; several are pure
deletions.

**Wave 2 — the two "quadratic monsters" and the relay hot path:**
W1 (code blocks blip in complete instead of rendering while streaming) · S2 + C1 (terminal,
both sides) · C2 (batch per frame) · R1 (skip dead push work) · R3 (stop phoning Clerk).
This wave is where "Turbo feels twice as fast" actually happens.

**Wave 3 — the bigger rebuilds, measuring as we go:**
S1 + S5 (small lookups) · S3 (projector map) · W11 (bundle splitting) · W9/C3 (keyed stores)
· C4 (cheaper unpacking) · S6 (shared fan-out) · S8/S9 (lazy diffs) · R4 (relay short-term
memory) · C6/C7 (small envelopes).

**Skipped by operator decision (2026-08-09):** W6, W7, W8 (glow and orbs stay exactly as
they are) · R2 (replay-protection stays in Postgres).

**Who owns what:** our own code (relay wiring, orbs, Turbo seams) we change directly. For
fixes in Theo's code, the smart move is often to send them upstream as small PRs — perf
fixes are exactly what they accept, we're a vouched contributor now, and every accepted fix
comes back to us automatically through the nightly sync with zero maintenance on our side.
