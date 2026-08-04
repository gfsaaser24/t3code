# T3 Turbo One-Way Official Data Import

## Goal

Replace the fork-specific requirement to run and connect to a second official T3 Code instance
with an explicit one-time import from official T3 Code into T3 Turbo's own state.

After import, Turbo is the only required local server. Imported projects and chats flow through
Turbo's normal local, relay, portal, and mobile paths. The import must not share a database,
transfer credentials, or reuse the official environment's identity.

## Product Decisions

- Import is desktop-only and runs before Turbo starts its primary backend.
- Before backend startup, when official state exists and no completed import/dismissal receipt is
  present, show an explicit native choice to import or keep the current Turbo state.
- The imported snapshot is installed as Turbo's actual
  `~/.t3-turbo/userdata/state.sqlite`. Turbo does not retain a second live database or connect to
  the official process after cutover. The staging copy exists only to validate and prepare the
  final database before an atomic install.
- An absent/empty Turbo domain store can import directly. A populated Turbo store uses a typed
  collision planner instead of rejecting the whole import.
- Match projects by normalized workspace root before project ID. Match chats by `ThreadId`, then
  compare their event-stream fingerprints so the UI can distinguish the same lineage from an
  unrelated UUID collision.
- For every matching chat, offer `Keep Turbo and skip official`, `Replace Turbo with official`, or
  `Keep both; import official with a new UUID`. Replacement is never implicit and every import is
  prepared against a recoverable Turbo backup.
- When event IDs, versions, and payload fingerprints prove one stream is an exact prefix, use the
  smallest safe result: fast-forward a Turbo prefix from the official tail, or no-op when official
  is equal to/behind Turbo. Divergent histories require the explicit choices above.
- A keep-both import remaps the official chat's entire T3-owned identity graph, not only its
  `ThreadId`. Event, command, message, turn, activity, approval, plan, checkpoint, and attachment
  identities must remain internally consistent and globally collision-free.
- Require official T3 Code to be closed. If it is running, explain the conflict and allow retry or
  starting Turbo without import; do not attach to it.
- The operation is one-way and never modifies official state. Official data is opened read-only
  and is never used as Turbo's live database. Replacing populated Turbo state is recoverable but
  requires explicit confirmation because it changes Turbo's active domain data.
- Existing official-managed Git worktrees keep their absolute paths under `~/.t3/worktrees`; do not
  move them because Git worktree metadata records those paths. New worktrees use Turbo's own home.

## Current Connector to Replace

Remove only the special official-local discovery and pairing behavior:

- `apps/desktop/src/app/OfficialT3EnvironmentDiscovery.ts`
- `apps/desktop/src/ipc/methods/officialT3Environment.ts`
- the related schema/bridge/channel/preload/handler wiring in `packages/contracts/src/ipc.ts` and
  `apps/desktop/src/ipc/`
- official-specific behavior in `apps/web/src/components/desktop/DesktopEnvironmentSwitcher.tsx`
  and its logic/tests

Retain the general environment registry and selection UI for real remote, relay, tunnel, SSH, and
WSL environments. The change removes `T3 Code` as a special second local live instance; it does not
remove T3 Code's remote-ready architecture.

## Replaceable Seam

Keep import mechanics under `apps/desktop/src/turbo/officialImport/`:

- `OfficialImport.ts` - Effect service and typed result/errors.
- `OfficialImportEligibility.ts` - pure source/destination/schema/transient-state decisions.
- `OfficialImportManifest.ts` - versioned receipt and explicit include/exclude policy.
- `OfficialImportSqlite.ts` - read-only validation, consistent snapshot, and auth sanitization.

Move the dependency-light migration ID/name manifest to a shared module consumed by both the
server migration loader and the desktop importer. Do not duplicate the list or import server source
files into the desktop bundle.

`apps/desktop/src/app/DesktopApp.ts` should have one shallow call before `primaryBackend.start`.
The importer must not be a server or relay RPC because only the local desktop owns both filesystem
paths and the destination server must not be running during installation.

Add the merge-specific mechanics to the same seam:

- `OfficialImportPlanner.ts` - project/thread matching, stream fingerprints, and user decisions.
- `OfficialImportIdMap.ts` - one typed source-to-target identity map for the complete import batch.
- `OfficialImportEventTransform.ts` - exhaustive schema-aware event transformation. Never perform
  text replacement inside arbitrary JSON.

## Read-Only SQLite Collision Audit - Complete 2026-08-04

- [x] Opened the live official and Turbo databases read-only and compared their schemas and
      identity columns without modifying either database.
- Both databases currently have the same 17-table schema and zero declared SQLite foreign keys.
  Relationships are enforced by typed application code and the projector, so raw row-level import
  cannot rely on SQLite to reject a broken graph.
- At audit time, official had 22 projected chats and Turbo had 1. There were zero overlapping
  project IDs, thread IDs, message IDs, activity IDs, plan IDs, event IDs, command IDs, or event
  streams. There was one shared normalized workspace root with different project IDs, confirming
  that project matching must consider paths instead of IDs alone.
- Thread state spans `orchestration_events`, `orchestration_command_receipts`,
  `projection_threads`, messages, activities, sessions, turns, pending approvals, proposed plans,
  `checkpoint_diff_blobs`, and `provider_session_runtime`.
- `orchestration_events.sequence` is a database-global autoincrement key;
  `(aggregate_kind, stream_id, stream_version)` and `event_id` are unique. Imported events must
  receive Turbo-local sequences, and each projector's global `projection_state` cursor must see the
  appended events.
- Command-receipt `result_sequence` points logically to that database-global event sequence even
  though SQLite declares no foreign key. Selected receipts must be recreated against the new
  Turbo sequence map, never copied with source sequence numbers.
- Attachments live outside SQLite and their IDs contain a normalized thread-ID segment. Checkpoint
  refs also encode the thread ID and exist as Git refs. Both must be renamed or duplicated with a
  cloned chat.

Conclusion: chat-level import is feasible. `ThreadId` matching is the correct first decision point,
but changing only that UUID would leave colliding or dangling child identities. The importer must
plan and transform the complete typed event graph in staging, then let the normal projectors build
the affected read models.

## Per-Chat Collision Resolution

For a source chat with no target `ThreadId` match, retain its thread ID unless the batch planner
finds another global identity collision. For a matching lineage, fast-forward only a verified
missing official tail and no-op when Turbo is already equal or ahead. For a divergent match:

1. `Keep Turbo and skip official` leaves the target stream untouched.
2. `Replace Turbo with official` keeps the matching `ThreadId`, removes only that Turbo stream and
   its derived/runtime rows in staging, then appends the transformed official stream.
3. `Keep both; import official with a new UUID` retains the Turbo stream and assigns the official
   chat a new `ThreadId` plus remapped subordinate identities.

The batch-level `OfficialImportIdMap` must cover:

- project and thread IDs;
- event, command, causation, and correlation IDs;
- message, turn, activity, approval-request, and proposed-plan IDs, including cross-thread plan
  references;
- attachment IDs/files and checkpoint refs/Git refs; and
- the `thread_id` key in provider session runtime state.

Provider-owned resume/session identifiers are external identities and are not blindly rewritten.
For replacement, retain the official settled runtime binding when it validates. A keep-both clone
is imported as settled history without a provider runtime row; preserving that row would let two
T3 threads control one external provider conversation. Its next turn starts a fresh provider
session.

## Import Manifest

Import:

- `state.sqlite` through a consistent SQLite snapshot.
- `attachments/` with post-copy existence/size validation.
- `keybindings.json` after schema validation.
- `settings.json` only through an explicit safe-field allowlist and user-visible choice; do not
  blindly copy provider environment values.

Never copy from official T3:

- `environment-id`
- `server-runtime.json`
- `secrets/`
- `anonymous-id`
- logs, provider logs, terminal logs, or caches
- SQLite `-wal` or `-shm` files
- desktop user data, Clerk/device identity, or the client connection catalog
- managed-relay, tunnel, pairing, or cloud credentials

Scrub from the staged database before installation:

- every row in `auth_sessions`
- every row in `auth_pairing_links`

Turbo generates or retains its own environment ID and authentication state. Provider CLI login
that already exists at the operating-system/user level can be used normally; credentials are not
copied from T3 state.

## Safe Import Flow

1. Resolve source `~/.t3/userdata` and destination `~/.t3-turbo/userdata` from the desktop
   environment service, never from renderer input.
2. Inspect the destination before startup. Snapshot a populated Turbo destination so every
   per-chat decision is recoverable; never modify the live database in place.
3. Confirm official T3 is not live; a stale runtime file alone does not count as a running process.
4. Open the source database read-only.
5. Verify `effect_sql_migrations` is an ordered prefix of Turbo's `migrationManifest`. Older sources
   can migrate forward; unknown or newer migrations fail closed.
6. Create consistent source and target snapshots on the destination volume with SQLite
   `VACUUM INTO`. Never plain-copy a live/WAL database.
7. Run current Turbo migrations against the staged snapshot, then refuse import while transient
   work exists:
   - `projection_thread_sessions.active_turn_id IS NOT NULL`
   - session status is `starting`, `connecting`, or `running`
   - `projection_turns.state` is `pending` or `running`
   - unresolved `projection_pending_approvals` exist
8. Match projects and thread IDs, fingerprint matching streams, collect the per-chat decisions,
   and build one immutable `OfficialImportIdMap` for the complete batch.
9. Start from the staged Turbo database. In one transaction, remove only explicitly replaced
   target thread graphs, decode and transform selected official events, append them with new
   Turbo-local sequence numbers, and recreate selected command receipts against the old-to-new
   sequence map. Do not copy source projection rows or raw receipt sequence numbers as
   authoritative state.
10. Replay the appended events through the normal projectors in batches until every projector
    cursor reaches the new maximum sequence. The current bootstrap read is bounded, so startup
    alone is not proof that a large import was fully projected.
11. Copy/remap approved attachments and checkpoint refs, carry forward Turbo-owned
    identity/settings/credentials, clear imported auth and unsafe live runtime state, and run
    integrity checks. Because Git refs live outside userdata, record a recovery journal and undo
    newly created refs if the database/directory swap fails.
12. Write a versioned receipt containing source path/fingerprint, source migration version,
    timestamp, per-chat decisions, complete ID map, backup location, and final event range.
13. Atomically swap the prepared userdata directory into Turbo's real location. On failure, roll
    back before startup and report the typed failure.
14. Start Turbo normally. Its own startup retains the Turbo environment identity, creates fresh
    local auth state, and publishes both retained and imported chats through the existing
    shell/thread streams.

## Task Breakdown

- [x] Audit the real official/Turbo SQLite schemas and current identity overlaps read-only.
- [ ] Define typed import eligibility, manifest, receipt, outcomes, and failure reasons, and expose
      one dependency-light migration manifest shared by server and desktop.
- [ ] Add pre-start detection plus project/thread matching and a native per-collision choice for
      skip, replace, or keep-both-with-new-UUID.
- [ ] Add an exhaustive, schema-aware `OfficialImportIdMap` and event transformer with a compile-
      time failure when upstream adds an unhandled event variant.
- [ ] Validate source/destination ownership, migration prefix compatibility, and official-process
      shutdown without opening source data read-write.
- [ ] Add transient-session/turn/approval refusal checks so no imported thread is stuck running.
- [ ] Build consistent source and target staging snapshots with SQLite `VACUUM INTO` and an
      explicit attachment/settings/checkpoint manifest.
- [ ] Sanitize auth tables and enforce the file/secret exclusion manifest.
- [ ] Append transformed events with Turbo-local global sequences, replay normal projectors, and
      run event-stream/projection/attachment/checkpoint integrity checks against staging.
- [ ] Make projection replay explicitly paginated and assert every projector cursor equals the
      staged database's maximum event sequence before cutover.
- [ ] Recreate selected command receipts from the destination sequence map; never retain official
      `result_sequence` values.
- [ ] Atomically install the prepared database at Turbo's real state path or roll back, and persist
      the idempotent import receipt.
- [ ] Start the normal Turbo backend and verify it generates a distinct environment identity and
      fresh local authentication.
- [ ] After the importer is verified in the same coordinated rollout, remove official-local
      discovery, pairing, IPC, and `T3 Code` special-case options while retaining generic
      environment switching.
- [ ] Update internal/user documentation to describe one-time import and the unchanged relay-link
      step for Turbo.

## Relay and Portal Behavior

- Turbo remains a new relay environment and is linked through the existing T3 Connect flow.
- Never transfer the official environment's relay link or credentials.
- Once Turbo is linked, imported projects and threads appear in portal/mobile through the normal
  snapshot and WebSocket event streams; the relay needs no import or pane-specific storage.
- Existing imported worktree/project paths remain local filesystem concerns of the Turbo backend.

## Acceptance Criteria

- A first-run Turbo install can import official projects, chat history, checkpoints, and attachments
  without starting official T3 Code.
- Official source bytes and database contents remain unchanged.
- A populated Turbo destination can import non-colliding chats and makes an explicit decision for
  every matching `ThreadId`; it is still refused for an incompatible schema, a running official
  app, or in-flight work.
- Replacing one matching chat changes no unselected Turbo chat or project. Keeping both produces a
  new thread UUID and a collision-free, internally consistent child identity graph.
- After cutover, the only live local state is Turbo's actual `~/.t3-turbo/userdata/state.sqlite`;
  no connector or secondary official runtime is required.
- Failure at any step does not leave a partially installed Turbo state.
- Turbo has a distinct environment ID, fresh auth sessions, and no copied secret/relay/runtime
  files after import.
- Imported threads are readable and settled. Non-cloned threads can continue where provider
  resumption validates; a keep-both clone deliberately starts a fresh provider session on its next
  turn.
- Turbo can be linked to relay normally and exposes the imported state through the existing portal
  and mobile clients.

## Focused Verification

- Source missing and user-declined flows.
- Successful absent/empty-target import and idempotent receipt behavior.
- Populated import with no `ThreadId` collision, including coalescing a project with the same
  normalized workspace root but a different project ID.
- Matching identical-prefix and divergent thread streams for each skip, replace, and keep-both
  choice.
- Exact-prefix fast-forward, equal/source-behind no-op, contiguous post-import stream versions, and
  the next normal command appending at the expected version.
- Child-only collisions in event, command, message, turn, activity, approval, plan, attachment,
  and checkpoint identities.
- Cross-thread proposed-plan references where both, one, or neither referenced thread is selected.
- Provider runtime handling: replacement resumes once when valid; keep-both never creates two live
  bindings to the same external provider session.
- Injected failure before and after projection replay proving restoration of the original Turbo
  store.
- More than 1,000 appended events proving projector replay drains every batch without skipping a
  sequence, plus a Git-ref failure proving the recovery journal undoes external checkpoint work.
- WAL-mode fixture proving a consistent snapshot rather than a raw file copy.
- Older-compatible and newer/unknown migration sets.
- Active session, running turn, and unresolved approval refusals.
- Auth row scrubbing and file-level secret/runtime/log exclusion.
- Allowlisted settings imported, excluded settings dropped, user-declined settings import, and
  malformed settings/keybindings rejected without partially installing the destination.
- Attachment copy/integrity and preserved absolute project/worktree paths.
- End-to-end backend startup showing imported projections, a new Turbo environment ID, fresh auth,
  and no inherited relay link.

## Delivery Order

The code may ship in the same coordinated T3 Turbo PR as the pane work, but the cutover order is
fixed:

1. Add and verify the importer/cutover prompt while the current connector remains available in the
   branch.
2. Prove imported data starts from Turbo's real database and appears through local and relay paths.
3. Remove the official-local connector/UI/IPC before merging the final PR.

Keep these as distinct commits/seams so the importer is always present before connector removal
and either customization can be recovered cleanly during nightly upstream integration.
