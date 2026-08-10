# 23a — C6-check: is mobile WebSocket compression actually on?

Measurement record for **C6-check** in `.plans/23-turbo-performance-audit.md:380-388`.
No product code was changed by this task.

## Verdict

| Direction | Platform | Compression | Confidence |
| --- | --- | --- | --- |
| server → phone | iOS | **OFF** | High |
| phone → server | iOS | **OFF** | High |
| server → phone | Android | **Probably ON** — unresolved | Medium |
| phone → server | Android | **Probably ON** — unresolved | Medium |

The plan predicted "off on React Native". That is **confirmed for iOS and only iOS**. The
Android transport is a different native stack (OkHttp, not SocketRocket) and it very likely
already negotiates `permessage-deflate` without anyone asking it to. Settling Android is the
cheapest next step and it changes the shape of the fix, so it is written up as step 1 below
rather than buried as a caveat.

## Why the client decides, not the server

Compression is negotiated once, per connection, in the HTTP upgrade — the client offers
`Sec-WebSocket-Extensions: permessage-deflate` and the server may only accept from what was
offered (RFC 7692). A client that never offers gets uncompressed frames in **both**
directions, and there is no server-side setting that can override that.

The repo already proves this against our own server: `apps/server/src/server.test.ts:3304-3330`
opens two sockets to the same server, differing only in the client's `perMessageDeflate` flag
(`:3313`). The offering client records the extension (`:3325`); the non-offering client
records nothing (`:3327-3328`).

## Evidence — what the phone actually constructs

1. `apps/mobile/src/lib/runtime.ts:29` injects `Socket.layerWebSocketConstructorGlobal`.
2. That layer is literally two arguments wide:
   `node_modules/.pnpm/effect@4.0.0-beta.103…/effect/src/unstable/socket/Socket.ts:580-582` —
   `(url, protocols) => new globalThis.WebSocket(url, protocols)`. React Native's third
   `options` argument is never passed, so even the one escape hatch RN offers is unused.
3. React Native's `WebSocket` has no compression knob to pass anyway:
   `apps/mobile/node_modules/react-native/Libraries/WebSocket/WebSocket.js:98-148`. The third
   argument is `{headers}` only; anything else is warned about and discarded (`:128-135`)
   before the call reaches the native module (`:148`).
4. Nothing in the app replaces the global. `WebSocket` appears in `apps/mobile/src` only at
   `runtime.ts:21` and `runtime.ts:29`.

### iOS — OFF (high confidence)

`apps/mobile/node_modules/react-native/React/CoreModules/RCTWebSocketModule.mm:15` hands the
connection to SocketRocket's `SRWebSocket`. That file contains no reference to extensions,
deflate, or compression, and SocketRocket has never implemented RFC 7692. No offer is sent,
so nothing is negotiated, so both directions travel as raw frames.

### Android — probably ON, unresolved (medium confidence)

`apps/mobile/node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/websocket/WebSocketModule.kt:94-142`
builds an OkHttp request and adds exactly four header kinds — `Cookie` (`:98`), caller-supplied
headers (`:113`), `origin` (`:124`), `Sec-WebSocket-Protocol` (`:138`) — then calls
`client.newWebSocket(...)` (`:142`). React Native neither adds nor suppresses an extension
header, so whatever OkHttp does by default is what happens on the wire.

The bundled OkHttp is **4.9.2** (`apps/mobile/node_modules/react-native/gradle/libs.versions.toml:36`).
OkHttp has advertised `Sec-WebSocket-Extensions: permessage-deflate` on every client WebSocket
since 4.3.0. **This was not verifiable inside this repo** — there is no OkHttp artifact on the
build machine and no emulator run was performed — so it is recorded as an open question, not a
finding.

## Evidence — the size of the gap

A probe (kept — see "Probe disposition") stood up a `ws` server configured exactly like the
Node branch of our server (`apps/server/src/server.ts:218`, `perMessageDeflate: true`) and
connected two clients to it with an 81,781-byte repetitive JSON payload sent each way:

| Client | Negotiated | server → client, on the wire | client → server, on the wire |
| --- | --- | --- | --- |
| offers `permessage-deflate` | `permessage-deflate` | 2,568 B | 2,621 B |
| never offers (RN-equivalent) | *(none)* | 81,920 B | 81,949 B |

About 32× on that synthetic payload. The repo's own measured figure for a real turn is the
one to plan against: **68 KB decoded vs an 8 KB wire budget** —
`apps/server/integration/TransferBudgetReport.integration.ts:36-37`, with the negotiated
extension asserted at `apps/server/src/server.test.ts:8228`. So an iOS phone today spends
roughly **8.5× the mobile data** of a browser or desktop client for the same turn.

## The sharp edge on the phone → server direction

`apps/server/src/server.ts:188-201` (the Bun branch) sets asymmetric compression on purpose:

- outbound `compress: "dedicated"` — a per-connection sliding window, shared across frames;
- inbound `decompress: "shared"` — chosen because *"uWebSockets' dedicated decompressor path
  can abort connections (close 1006) on valid DEFLATE input — see
  https://github.com/uNetworking/uWebSockets.js/issues/633"* (`:193-196`).

Read plainly: **inbound compressed traffic is the fragile side of this server.** The safe
setting is also the weaker one — a shared decompressor keeps no per-connection history, so a
client compressing *to* it cannot carry a dictionary across messages. Small, frequent
phone→server frames (keystrokes, cursor moves, acks) would therefore compress poorly or not at
all, while the big server→phone payloads compress well. *(The no-context-takeover consequence
is inferred from uWS's shared-vs-dedicated semantics; the comment states the abort risk, not
the window behaviour. Confirm before sizing the inbound half of the win.)*

Scope note: the Node branch (`apps/server/src/server.ts:208-219`) is plain
`perMessageDeflate: true` via `ws`, with context takeover on and no equivalent warning. The
desktop app spawns the server under Node (`apps/desktop/src/backend/DesktopBackendConfiguration.ts:542`,
`node …/apps/server/dist/bin.mjs`), so the sharp edge belongs to Bun-hosted deployments.

**Coverage gap this exposes:** the only inbound-compression exercise we have runs on the Node/`ws`
path (`server.test.ts:8228` onward, which dispatches commands over the compressed socket). The
Bun/uWS inbound path — the one with the documented 1006 abort — has no test that pushes real
compressed client traffic through it.

## The decision this tees up

**Step 1 — settle Android before spending anything (≈10 minutes, no dependency change).**
Log `sec-websocket-extensions` from the upgrade request on a locally-run server and connect an
Android dev build. If Android already compresses, the whole item is an iOS-only fix and its
value halves; it also means Android phones are *already* driving compressed traffic into the
server's inbound path today, which makes Step 3 urgent rather than speculative.

**Step 2 — the dependency decision (iOS, and Android if Step 1 says off).**
There is no configuration fix. React Native's WebSocket cannot offer the extension, so the
change is to stop using it: supply a custom `WebSocketConstructor` instead of
`Socket.layerWebSocketConstructorGlobal` at `apps/mobile/src/lib/runtime.ts:29` — i.e.
`Layer.succeed(Socket.WebSocketConstructor)(myCtor)` — backed by a compression-capable native
socket shipped as a local Expo module. The app already ships three local native modules
(`apps/mobile/modules/t3-terminal`, `t3-review-diff`, `t3-markdown-text`), so the packaging
pattern exists; the open part is which implementation to adopt (Starscream on iOS is the
obvious candidate to evaluate — unverified here). Cost is a native module plus a config
plugin, plus permanent maintenance of a transport the platform used to own. That is a project,
not a tweak, exactly as the plan says.

**Step 3 — guard the inbound direction before turning it on.**
Whichever library is adopted, making the phone compress means phone→server frames start
exercising the server's inbound DEFLATE path. Keep `decompress: "shared"` on the Bun branch,
and add a test that pushes genuinely compressed client payloads through the Bun/uWS server —
not just an assertion on the negotiated extension string. Enabling client-side compression
without that test would be shipping traffic into a path with a known abort bug and no coverage.

## Probe disposition

**Kept**, as a fork-owned test: `apps/server/src/turbo/websocketCompressionNegotiation.test.ts`
(293 ms, passing). No seam registration is required — it creates a new file under `*/turbo/`
and modifies no upstream-owned file.

It was trimmed to the part that is not already covered. The upstream test at
`server.test.ts:3304-3330` asserts the *negotiated extension string*; this one pins the
*consequence in bytes* — the non-offering client's wire bytes stay at or above its decoded
bytes in both directions, which is the number the phone actually pays. The table above uses
the larger throwaway payload from the original probe run; the kept test uses a smaller one so
it stays sub-second.
