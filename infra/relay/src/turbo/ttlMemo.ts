// T3 Turbo: the one TTL memo the relay uses.
//
// Two independent per-isolate caches grew the same hand-rolled map: the Clerk token verification
// memo in `http/Api.ts` and the environment-link lookup memo in `environments/EnvironmentLinks.ts`.
// They are unified here so the eviction rule is written once and is correct once.
//
// The eviction rule is the part worth stating. The original swept expired entries and then, if the
// map was still full, `clear()`ed it. When a map is full of LIVE entries -- which is exactly the
// condition that makes a cache worth having -- the sweep frees nothing and the clear throws away
// the entire hot working set, so above `limit` concurrent live keys the memo does strictly negative
// work per request. Here a full map instead drops entries in insertion order, which is a plain LRU
// for a map that is only ever written on a miss.
//
// This stays a per-isolate `Map` on purpose. A miss costs one verification or one query; shared or
// durable storage would widen the staleness window across locations instead of narrowing it.

interface TtlMemoEntry<A> {
  readonly value: A;
  readonly expiresAtMs: number;
}

export interface TtlMemo<A> {
  readonly entries: Map<string, TtlMemoEntry<A>>;
  readonly limit: number;
}

export function makeTtlMemo<A>(limit: number): TtlMemo<A> {
  return { entries: new Map(), limit };
}

/** Returns the remembered value, or `null` when there is none or it has expired. */
export function readTtlMemo<A>(memo: TtlMemo<A>, key: string, nowMs: number): A | null {
  const remembered = memo.entries.get(key);
  if (remembered === undefined) {
    return null;
  }
  if (remembered.expiresAtMs <= nowMs) {
    memo.entries.delete(key);
    return null;
  }
  return remembered.value;
}

/**
 * Remembers `value` until `expiresAtMs`. An entry that is already expired is not remembered at
 * all, which is how a caller passes "this token expires before the cap would" without a branch.
 */
export function writeTtlMemo<A>(
  memo: TtlMemo<A>,
  key: string,
  value: A,
  expiresAtMs: number,
  nowMs: number,
): void {
  if (expiresAtMs <= nowMs) {
    return;
  }
  if (memo.entries.size >= memo.limit) {
    for (const [rememberedKey, remembered] of memo.entries) {
      if (remembered.expiresAtMs <= nowMs) {
        memo.entries.delete(rememberedKey);
      }
    }
    // Insertion order is least-recently-written order here, because entries are only ever written
    // on a miss and are never re-written on a hit.
    while (memo.entries.size >= memo.limit) {
      const oldest = memo.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      memo.entries.delete(oldest.value);
    }
  }
  memo.entries.set(key, { value, expiresAtMs });
}

export function forgetTtlMemo<A>(memo: TtlMemo<A>, key: string): void {
  memo.entries.delete(key);
}
