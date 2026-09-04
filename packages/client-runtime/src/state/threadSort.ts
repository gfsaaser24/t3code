import type { OrchestrationThreadShell, ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ThreadSortInput {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt?: string | null;
  readonly messages?: ReadonlyArray<{
    readonly createdAt: string;
    readonly role: string;
  }>;
}

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type SettledThreadTimestampInput = Pick<
  OrchestrationThreadShell,
  "settledAt" | "latestUserMessageAt" | "latestTurn" | "updatedAt"
>;

/** The timestamp a settled row sorts and labels by on every client: settledAt
    when stamped, otherwise the latest message or turn stamp, then updatedAt. */
export function resolveSettledThreadTimestamp(thread: SettledThreadTimestampInput): string | null {
  if (thread.settledAt != null && toSortableTimestamp(thread.settledAt) !== null) {
    return thread.settledAt;
  }

  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    const parsed = toSortableTimestamp(candidate ?? undefined);
    if (candidate != null && parsed !== null && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  if (latest !== null) return latest;
  return toSortableTimestamp(thread.updatedAt) === null ? null : thread.updatedAt;
}

function getFirstSortableTimestamp(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    const timestamp = toSortableTimestamp(value ?? undefined);
    if (timestamp !== null) {
      return timestamp;
    }
  }

  return null;
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number {
  if (thread.latestUserMessageAt) {
    const latestUserMessageTimestamp = toSortableTimestamp(thread.latestUserMessageAt);
    if (latestUserMessageTimestamp !== null) {
      return latestUserMessageTimestamp;
    }
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return getFirstSortableTimestamp(thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return (
      getFirstSortableTimestamp(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY
    );
  }
  return getLatestUserMessageTimestamp(thread);
}

/**
 * Sort anchor for the active thread list: creation time, re-anchored to
 * unsettledAt when the thread last re-entered the active list (an explicit
 * un-settle, or a settled thread waking on activity). The list stays static
 * between lifecycle transitions, but an un-settled thread surfaces at the
 * top instead of sinking back to its creation-order slot. Shared by web and
 * mobile so both render the same order. Malformed timestamps sink to 0.
 */
export function activeThreadAnchorTimestampMs(thread: {
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
}): number {
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
  );
}

export function sortThreads<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  return Arr.sort(
    threads,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        id: Order.flip(Order.String),
      }),
      (thread: T) => ({
        timestamp: getThreadSortTimestamp(thread, sortOrder),
        id: thread.id,
      }),
    ),
  );
}

export function getLatestThreadForProject<
  T extends {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly archivedAt: string | null;
  } & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null {
  return (
    sortThreads(
      threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
      sortOrder,
    )[0] ?? null
  );
}

// ── Pinned reorder: fractional index keys ──────────────────────────────
// Pinned threads carry an optional pinOrderKey (a base-26 string). The
// pinned block sorts keyed threads by plain string comparison, so a drag
// (web) or Move up/down (mobile) writes ONE key to ONE thread on that
// thread's own server — neighbors, possibly living on other servers, are
// never touched, and every client connected to the same servers converges
// on the same order.
const PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidPinOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!PIN_ORDER_DIGITS.includes(char)) return false;
  }
  // A trailing minimum digit would leave no room to sort a key immediately
  // before this one; generators never produce it, so treat it as corrupt.
  return key.at(-1) !== PIN_ORDER_DIGITS[0];
}

/** Midpoint of two digit strings interpreted as fractions in (0, 1).
    "" stands for the open bound on either side. Requires a < b. */
function pinOrderMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("pinOrderMidpoint: bounds out of order");
  if (b !== "") {
    // Recurse past the longest common prefix ("a" pads the shorter side).
    let n = 0;
    while ((a.charAt(n) || PIN_ORDER_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + pinOrderMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : PIN_ORDER_DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? PIN_ORDER_DIGITS.length : PIN_ORDER_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return PIN_ORDER_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  // Consecutive leading digits: either b has spare digits to shorten into,
  // or we extend a (never producing a trailing minimum digit — the base
  // case midpoint("", "") is the middle of the alphabet).
  if (b.length > 1) return b.charAt(0);
  return PIN_ORDER_DIGITS.charAt(digitA) + pinOrderMidpoint(a.slice(1), "");
}

/** Key that sorts strictly between two neighbors; null bounds mean "top of
    the pinned block" / "bottom of the keyed run". Returns null instead of
    throwing when existing keys are corrupt or out of order — callers fall
    back to rewriting the section. */
export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidPinOrderKey(a)) return null;
  if (b !== "" && !isValidPinOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return pinOrderMidpoint(a, b);
}

/** Evenly spaced keys for rewriting a whole pinned section (used when a
    drop lands next to keyless threads, so single-key insertion has nothing
    to anchor on). Two base-26 digits give 675 slots — far beyond any real
    pinned section — with monotonicity enforced as a belt-and-braces. */
export function generateSpreadPinOrderKeys(count: number): string[] {
  const space = PIN_ORDER_DIGITS.length * PIN_ORDER_DIGITS.length;
  const step = space / (count + 1);
  const keys: string[] = [];
  let previous = 0;
  for (let i = 0; i < count; i += 1) {
    let value = Math.max(Math.round(step * (i + 1)), previous + 1);
    // Skip values whose low digit is the minimum (a trailing "a" key).
    if (value % PIN_ORDER_DIGITS.length === 0) value += 1;
    value = Math.min(value, space - 1);
    previous = value;
    keys.push(
      PIN_ORDER_DIGITS.charAt(Math.floor(value / PIN_ORDER_DIGITS.length)) +
        PIN_ORDER_DIGITS.charAt(value % PIN_ORDER_DIGITS.length),
    );
  }
  return keys;
}

/**
 * Assignments needed to realize a new pinned order. When the moved thread
 * sits between two keyed (or absent) neighbors, this is a single write to
 * the moved thread. When a neighbor is keyless (threads pinned before
 * reordering shipped), the whole section gets fresh spread keys — a
 * one-time materialization; every move after that is single-write.
 */
export function planPinnedReorder(input: {
  /** Thread ids in the desired visual order (after the move). */
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const { orderedIds, keysById, movedId } = input;
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1] : null;
  const afterId = movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1] : null;
  const beforeKey = beforeId != null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId != null ? (keysById.get(afterId) ?? null) : null;
  const beforeUsable = beforeId === null || beforeKey != null;
  const afterUsable = afterId === null || afterKey != null;
  if (beforeUsable && afterUsable) {
    const key = pinOrderKeyBetween(beforeKey, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  // Keyless neighbor (or corrupt keys): rewrite the section in the new order.
  const keys = generateSpreadPinOrderKeys(orderedIds.length);
  return orderedIds.flatMap((id, index) => {
    const key = keys[index]!;
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }];
  });
}

const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Parses `[start, end)` as a zero-padded decimal; -1 when any code unit in
    the span is not a digit. Allocation-free, no regex — this runs per
    comparison and mobile is on Hermes. */
function decimalAt(value: string, start: number, end: number): number {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    const digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return -1;
    total = total * 10 + digit;
  }
  return total;
}

/**
 * True only for `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real UTC instant — the
 * exact and only shape the product mints (`DateTime.formatIso`, i.e.
 * `toISOString`). For two strings of that shape, every field is zero-padded at
 * a fixed index, so code-unit order IS chronological order and the comparator
 * can skip `Date.parse`.
 *
 * Accepting must imply `Date.parse` equivalence; rejecting is always safe
 * because the caller then runs the original parse comparator. Hence the range
 * checks — `2026-13-45T…` and `2026-02-30T…` are shaped right but parse to
 * NaN, and those have to keep sinking to the epoch.
 */
function isCanonicalIsoTimestamp(value: string): boolean {
  if (value.length !== 24) return false;
  if (
    value.charCodeAt(4) !== 45 /* - */ ||
    value.charCodeAt(7) !== 45 /* - */ ||
    value.charCodeAt(10) !== 84 /* T */ ||
    value.charCodeAt(13) !== 58 /* : */ ||
    value.charCodeAt(16) !== 58 /* : */ ||
    value.charCodeAt(19) !== 46 /* . */ ||
    value.charCodeAt(23) !== 90 /* Z */
  ) {
    return false;
  }
  const year = decimalAt(value, 0, 4);
  const month = decimalAt(value, 5, 7);
  const day = decimalAt(value, 8, 10);
  const hour = decimalAt(value, 11, 13);
  const minute = decimalAt(value, 14, 16);
  const second = decimalAt(value, 17, 19);
  const millisecond = decimalAt(value, 20, 23);
  if (year < 0 || month < 1 || month > 12 || day < 1) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  if (millisecond < 0) return false;
  const isLeapFebruary = month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0);
  return day <= (isLeapFebruary ? 29 : DAYS_PER_MONTH[month - 1]!);
}

/**
 * Pinned block order: user-arranged keys first (string comparison, id
 * tiebreak), then keyless threads newest-created first — so threads on
 * servers that predate reordering keep the static creation order at the
 * bottom of the block instead of breaking the section.
 */
export function sortPinnedThreadsByOrderKey<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly pinOrderKey?: string | null | undefined;
    /** Thread ids are only unique within an environment, and the pinned
        block merges environments — the tiebreak needs both parts or two
        clients could render equal-key threads in stream-arrival order. */
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  const keyed: T[] = [];
  const keyless: T[] = [];
  for (const thread of threads) {
    (thread.pinOrderKey != null ? keyed : keyless).push(thread);
  }
  const identityTiebreak = (left: T, right: T) =>
    left.id.localeCompare(right.id) ||
    (left.environmentId ?? "").localeCompare(right.environmentId ?? "");
  keyed.sort((left, right) => {
    const leftKey = left.pinOrderKey!;
    const rightKey = right.pinOrderKey!;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : identityTiebreak(left, right);
  });
  // createdAt is minted fixed width (`DateTime.formatIso`), so newest-first is
  // a plain string comparison — the same shape as the keyed sort above, and no
  // Date.parse pair per comparison on a list that re-sorts as threads stream.
  // Anything that is NOT a canonical stamp (offset forms, second-precision
  // forms, "unknown") falls back to the parse-with-epoch-sink comparator this
  // replaced, byte for byte: `IsoDateTime` is `Schema.String`, so nothing at
  // the boundary stops a server from sending one, and a letter-leading string
  // must keep sinking to the bottom rather than float to the top as "newest".
  // The two branches are one comparator: for canonical operands code-unit
  // order IS parse order, so the mixed case stays transitive.
  keyless.sort((left, right) => {
    const leftCreatedAt = left.createdAt;
    const rightCreatedAt = right.createdAt;
    if (isCanonicalIsoTimestamp(leftCreatedAt) && isCanonicalIsoTimestamp(rightCreatedAt)) {
      return leftCreatedAt > rightCreatedAt
        ? -1
        : leftCreatedAt < rightCreatedAt
          ? 1
          : identityTiebreak(left, right);
    }
    const leftMs = Date.parse(leftCreatedAt);
    const rightMs = Date.parse(rightCreatedAt);
    return (
      (Number.isNaN(rightMs) ? 0 : rightMs) - (Number.isNaN(leftMs) ? 0 : leftMs) ||
      identityTiebreak(left, right)
    );
  });
  return [...keyed, ...keyless];
}

/**
 * planPinnedReorder specialized for mobile's Move up / Move down menu
 * actions: swap the moved thread with its displayed neighbor. Null when the
 * move falls off either end of the list. Same single-write-per-move
 * semantics as a web drag.
 */
export function planPinnedMove(input: {
  /** Reorder-capable pinned thread ids in displayed order. */
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
  readonly direction: "up" | "down";
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> | null {
  const { orderedIds, keysById, movedId, direction } = input;
  const from = orderedIds.indexOf(movedId);
  if (from === -1) return null;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= orderedIds.length) return null;
  const newOrder = [...orderedIds];
  newOrder.splice(from, 1);
  newOrder.splice(to, 0, movedId);
  return planPinnedReorder({ orderedIds: newOrder, keysById, movedId });
}
