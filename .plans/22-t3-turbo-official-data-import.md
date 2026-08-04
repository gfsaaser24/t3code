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
- An absent/empty Turbo domain store can import directly. If Turbo already contains projects,
  threads, or events, do not attempt an automatic row merge: identical schemas do not prevent
  entity IDs, stream versions, sequence numbers, projections, and checkpoints from colliding.
  Offer only cancel or an explicit replace-from-official path backed by a recoverable Turbo backup.
- Replacing a populated Turbo store is never implicit. Preserve Turbo-owned identity, settings,
  and external credentials in the replacement bundle, and retain the backup until the imported
  backend starts and verifies successfully.
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
2. Inspect the destination before startup. Proceed automatically only when it is absent or has no
   domain events/projects/threads. A populated target requires an explicit replace confirmation
   and a verified recoverable backup; never silently merge or overwrite it.
3. Confirm official T3 is not live; a stale runtime file alone does not count as a running process.
4. Open the source database read-only.
5. Verify `effect_sql_migrations` is an ordered prefix of Turbo's `migrationManifest`. Older sources
   can migrate forward; unknown or newer migrations fail closed.
6. Create a staging directory on the destination volume and snapshot with SQLite `VACUUM INTO`.
   Never plain-copy a live/WAL database.
7. Run current Turbo migrations against the staged snapshot, then refuse import while transient
   work exists:
   - `projection_thread_sessions.active_turn_id IS NOT NULL`
   - session status is `starting`, `connecting`, or `running`
   - `projection_turns.state` is `pending` or `running`
   - unresolved `projection_pending_approvals` exist
8. Copy approved attachments/settings, clear auth rows, and validate the staged snapshot and
   referenced attachment files.
9. Write a versioned receipt containing source path, source migration version, timestamp, import
   mode, backup location when applicable, and a non-secret database fingerprint.
10. Install the prepared snapshot as Turbo's real `userdata/state.sqlite`. For a new destination,
    atomically rename the prepared userdata directory on the same volume. For an explicitly
    replaced destination, atomically swap the prepared directory with the backed-up Turbo
    directory while carrying forward Turbo-owned identity/settings/credentials. On failure, roll
    back before startup and report the typed failure.
11. Start Turbo normally. Its own startup generates or retains the Turbo environment identity,
    creates fresh local auth state, and publishes the imported state through the existing
    shell/thread streams.

## Task Breakdown

- [ ] Define typed import eligibility, manifest, receipt, outcomes, and failure reasons, and expose
      one dependency-light migration manifest shared by server and desktop.
- [ ] Add pre-start detection and a native import/start-fresh prompt; when Turbo contains domain
      data, add a separate explicit replace/cancel decision with a recoverable backup.
- [ ] Validate source/destination ownership, migration prefix compatibility, and official-process
      shutdown without opening source data read-write.
- [ ] Add transient-session/turn/approval refusal checks so no imported thread is stuck running.
- [ ] Build the staging snapshot with SQLite `VACUUM INTO` and explicit attachment/settings copy.
- [ ] Sanitize auth tables and enforce the file/secret exclusion manifest.
- [ ] Run migrations and a projection/attachment integrity read against staging.
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
- Import is refused for a populated Turbo destination unless the user explicitly selects the
  backed-up replace path, and is always refused for an incompatible schema, a running official
  app, or in-flight work.
- After cutover, the only live local state is Turbo's actual `~/.t3-turbo/userdata/state.sqlite`;
  no connector or secondary official runtime is required.
- Failure at any step does not leave a partially installed Turbo state.
- Turbo has a distinct environment ID, fresh auth sessions, and no copied secret/relay/runtime
  files after import.
- Imported threads are readable, settled, and can continue normally where the provider supports
  resumption.
- Turbo can be linked to relay normally and exposes the imported state through the existing portal
  and mobile clients.

## Focused Verification

- Source missing and user-declined flows.
- Successful absent/empty-target import and idempotent receipt behavior.
- Initialized-but-domain-empty import while preserving Turbo-owned identity and external secrets.
- Populated destination cancel behavior, explicit backed-up replacement, successful verification,
  and injected failure proving restoration of the original Turbo store.
- WAL-mode fixture proving a consistent snapshot rather than a raw file copy.
- Older-compatible and newer/unknown migration sets.
- Active session, running turn, and unresolved approval refusals.
- Auth row scrubbing and file-level secret/runtime/log exclusion.
- Allowlisted settings imported, excluded settings dropped, user-declined settings import, and
  malformed settings/keybindings rejected without partially installing the destination.
- Attachment copy/integrity and preserved absolute project/worktree paths.
- Injected failure before commit proving atomic rollback.
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
