import * as Arr from "effect/Array";
import type * as O from "effect/Order";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Timestamp ordering for sort comparators. Every timestamp on the wire is
 * minted fixed width (`DateTime.formatIso` / `toISOString`), so two operands
 * differ first at a digit sitting at the same index — code-unit order is then
 * identical to `localeCompare`'s, without the collator. These comparators run
 * inside sorts that re-run per streamed word, so the collation is pure cost.
 */
export function compareIsoTimestamps(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Lifecycle phase of an activity kind, used to break ties on
 * `(sequence, createdAt)`. Keeping `.started` before `.progress`/`.updated`
 * before `.completed`/`.resolved` is what stops an approval's *resolved* row
 * from landing before its *requested* row and painting a phantom pending
 * approval badge.
 */
export function activityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

/**
 * Sort key for an activity that has no `sequence`.
 *
 * Un-numbered rows are NOT a legacy-only population. Migration
 * `008_ProjectionThreadActivitySequence` added the column with no backfill, so
 * pre-008 rows have no sequence — but several LIVE emitters also append
 * `thread.activity.append` with no `sequence` at all: `CheckpointReactor`
 * ("Checkpoint captured", every turn, plus the capture/revert failure rows),
 * `ws.ts`'s setup-script activities, and `ProviderCommandReactor`'s error
 * rows. Only `ProviderRuntimeIngestion.runtimeEventToActivities` numbers what
 * it emits.
 *
 * So a missing sequence means "not part of the provider's numbered stream",
 * not "oldest". `MAX_SAFE_INTEGER` sinks those rows below the numbered ones
 * and lets `createdAt` order them among themselves — which is what the store
 * reducer and mobile always did, and therefore what the rendered thread
 * timeline has always shown. Under a missing-FIRST convention every turn's
 * "Checkpoint captured" row would hoist itself above the thread's very first
 * activity.
 *
 * The cost is that genuine pre-008 rows sit at the BOTTOM of an old thread
 * rather than the top. That is the accepted trade — it is the behavior the
 * store and mobile already shipped, and it is the only convention that keeps
 * live un-sequenced rows in place.
 *
 * All four server ORDER BY clauses spell the same thing out explicitly with
 * `CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC`, because SQLite's default
 * is NULLs-FIRST and a bare `sequence ASC` would disagree with this file.
 */
const MISSING_SEQUENCE = Number.MAX_SAFE_INTEGER;

/**
 * The one canonical order for `OrchestrationThreadActivity` rows: sequence,
 * then creation timestamp, then lifecycle phase, then id (code-unit order, to
 * match the server's `activity_id ASC` under SQLite's BINARY collation).
 *
 * Shared by the store reducer, the older-page merge, the web view layer, the
 * mobile view layer, and (as SQL) the server's projection queries, so that the
 * arrays those surfaces hand each other are already in agreement and nobody
 * has to re-sort defensively.
 *
 * Plain comparator, no `Order` combinators in the hot path: this module is
 * shared with mobile, so it must stay Hermes-safe and allocation-free.
 */
export function compareThreadActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): -1 | 0 | 1 {
  const leftSequence = left.sequence ?? MISSING_SEQUENCE;
  const rightSequence = right.sequence ?? MISSING_SEQUENCE;
  if (leftSequence !== rightSequence) {
    return leftSequence < rightSequence ? -1 : 1;
  }

  const createdAtComparison = compareIsoTimestamps(left.createdAt, right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const leftRank = activityLifecycleRank(left.kind);
  const rightRank = activityLifecycleRank(right.kind);
  if (leftRank !== rightRank) {
    return leftRank < rightRank ? -1 : 1;
  }

  // Code-unit comparison, NOT `localeCompare`. The server breaks the same tie
  // with `activity_id ASC`, and SQLite's default BINARY collation compares
  // UTF-8 bytes — which for these ids is code-unit order. Using the ICU
  // collator here would give the client a different total order from the SQL
  // for ids that differ only in case or in digit-versus-letter position, and
  // would drag the collator into the store's per-append sort and mobile's
  // Hermes path, where this module is required to stay cheap.
  const leftId = left.id;
  const rightId = right.id;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** `compareThreadActivities` as an Effect `Order`, for `Arr.sort` call sites. */
export const threadActivityOrder: O.Order<OrchestrationThreadActivity> = compareThreadActivities;

/**
 * Sorts activities into canonical order. Every activity-derived view
 * (`derivePendingApprovals`, `derivePendingUserInputs`, work log, turn plans,
 * active plan) expects this ordering; sorting once at the boundary and passing
 * the result to all of them avoids re-sorting the full activity history per
 * derivation on every streamed token.
 */
export function sortThreadActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  return Arr.sort(activities, threadActivityOrder);
}
