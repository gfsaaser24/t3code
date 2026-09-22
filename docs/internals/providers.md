# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).

## Session teardown and background work

Background tasks (subagent fleets, monitors, background shells) live inside the provider's child
process, so no task survives its session. Three rules keep that honest:

- **Teardown reports the loss.** When a Claude session tears down with tasks still tracked as live
  (`liveTaskIds` in `apps/server/src/provider/Layers/ClaudeAdapter.ts`), the adapter emits a
  terminal `task.completed(status: "stopped")` per task, and — when the teardown was caused by the
  SDK stream ending rather than a user action — a `runtime.error` naming the lost agents plus a
  structured `claude.session.stream-ended-with-live-tasks` log capturing the exit shape. The
  session still tears down; resume happens through the normal recovery path on the next message.
- **The binding follows the session.** Every `session.exited` event that flows through
  `ProviderService`'s event pump marks the persisted runtime binding `stopped`, so adapter-internal
  exits (stream end, session replace, adapter stopAll) cannot leave ghost `running` rows behind. A
  stale exit cannot stomp a replacement session's binding: the pump skips the sync when the binding
  is owned by a different provider instance than the one that emitted the exit, or when the
  emitting adapter holds a session created after the exit event. The same pump touches the
  binding's `lastSeenAt` on turn lifecycle (`turn.started`, `turn.completed`) and task lifecycle
  (`task.started`, `task.progress`, `task.updated`, `task.completed`) events, throttled per thread:
  turns the provider starts on its own (background task notifications waking the agent) never route
  through `sendTurn`, and without the touch a thread doing autonomous work reads as idle from the
  user's last message.
- **The reaper respects background work.** `ProviderSessionReaper` skips idle sessions while
  `ThreadBackgroundLivenessService` reports live work for the thread, up to a wedge cap
  (`backgroundWorkMaxIdleMs`, default 4h) after which a session is reaped anyway — a task that
  never reaches a terminal state must not pin its child process forever.
