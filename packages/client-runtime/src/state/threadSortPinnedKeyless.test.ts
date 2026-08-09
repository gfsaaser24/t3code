/**
 * T3 Turbo (fork-owned): the keyless half of the pinned block used to run a
 * `Date.parse` pair on every comparison. `createdAt` is minted fixed width
 * (`DateTime.formatIso`), so newest-first is a plain string comparison — this
 * pins the emitted order against the pre-change implementation, ties included.
 * Both web and mobile call `sortPinnedThreadsByOrderKey`, so this covers both.
 */
import { describe, expect, it } from "vite-plus/test";

import { sortPinnedThreadsByOrderKey } from "./threadSort.ts";

type PinnedRow = {
  readonly id: string;
  readonly createdAt: string;
  readonly pinOrderKey?: string | null | undefined;
  readonly environmentId?: string | undefined;
};

/** The implementation as it stood before the swap, verbatim. */
function legacySortPinnedThreadsByOrderKey<T extends PinnedRow>(threads: readonly T[]): T[] {
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
  keyless.sort((left, right) => {
    const leftMs = Date.parse(left.createdAt);
    const rightMs = Date.parse(right.createdAt);
    return (
      (Number.isNaN(rightMs) ? 0 : rightMs) - (Number.isNaN(leftMs) ? 0 : leftMs) ||
      identityTiebreak(left, right)
    );
  });
  return [...keyed, ...keyless];
}

/** Deterministic LCG so the corpus is identical on every machine.
 *  `Math.imul` is load-bearing: `state * 1103515245` overflows 2^53 for most
 *  states, and the float rounding that follows collapses the generator to a
 *  ~10k-value cycle. Shared constants with the twin generator in
 *  `apps/web/src/turbo/sortOrderEquivalence.test.ts` — keep the two identical
 *  so a corpus can be reproduced from either file. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state % 2147483648) / 2147483648;
  };
}

function corpus(): PinnedRow[][] {
  const random = makeRandom(0x1d7a53f);
  // Only product-minted stamps: repeated values force timestamp ties, and the
  // repeated id/environmentId pairs force the identity tiebreak to decide.
  const stamps = [
    "2026-03-09T10:00:00.000Z",
    "2026-03-09T10:00:00.000Z",
    "2026-03-09T10:00:00.001Z",
    "2026-03-09T09:59:59.999Z",
    "2025-12-31T23:59:59.999Z",
    "1970-01-01T00:00:00.000Z",
  ];
  const ids = ["alpha", "beta", "Alpha", "alpha"];
  const environments = [undefined, "env-a", "env-b", "env-a"];
  const keys = [null, undefined, "m", "mm", "n"];
  const batches: PinnedRow[][] = [];
  for (let batch = 0; batch < 80; batch += 1) {
    const size = 2 + Math.floor(random() * 8);
    const rows: PinnedRow[] = [];
    for (let index = 0; index < size; index += 1) {
      rows.push({
        id: ids[Math.floor(random() * ids.length)]!,
        createdAt: stamps[Math.floor(random() * stamps.length)]!,
        pinOrderKey: keys[Math.floor(random() * keys.length)],
        environmentId: environments[Math.floor(random() * environments.length)],
      });
    }
    batches.push(rows);
  }
  return batches;
}

/** Stamps the fast path must refuse: `IsoDateTime` is `Schema.String`, so a
    server can put any of these on the wire and the fallback comparator has to
    reproduce the pre-swap order for them exactly. */
function nonCanonicalCorpus(): PinnedRow[][] {
  const random = makeRandom(0x4c1b93d);
  const stamps = [
    // Canonical, so pairs mix fast path and fallback.
    "2026-03-09T10:00:00.000Z",
    "2026-03-09T10:00:00.999Z",
    // Valid but not toISOString-shaped: seconds precision, offset form, RFC 2822.
    "2026-03-09T10:00:00Z",
    "2026-03-09T05:00:00.000-05:00",
    "Mon, 09 Mar 2026 10:00:00 GMT",
    // Unparseable: must sink to the epoch, not float to the top.
    "unknown",
    "Invalid date",
    // Shaped like a canonical stamp but not a real calendar date: one is
    // unparseable, the other rolls forward into the next month.
    "2026-13-09T10:00:00.000Z",
    "2026-02-30T10:00:00.000Z",
  ];
  const ids = ["alpha", "beta", "Alpha", "alpha"];
  const environments = [undefined, "env-a", "env-b"];
  const keys = [null, undefined, "m"];
  const batches: PinnedRow[][] = [];
  for (let batch = 0; batch < 120; batch += 1) {
    const size = 2 + Math.floor(random() * 8);
    const rows: PinnedRow[] = [];
    for (let index = 0; index < size; index += 1) {
      rows.push({
        id: ids[Math.floor(random() * ids.length)]!,
        createdAt: stamps[Math.floor(random() * stamps.length)]!,
        pinOrderKey: keys[Math.floor(random() * keys.length)],
        environmentId: environments[Math.floor(random() * environments.length)],
      });
    }
    batches.push(rows);
  }
  return batches;
}

describe("sortPinnedThreadsByOrderKey keyless block", () => {
  it("emits the pre-swap order for product-minted timestamps, ties included", () => {
    for (const rows of corpus()) {
      expect(sortPinnedThreadsByOrderKey(rows)).toEqual(legacySortPinnedThreadsByOrderKey(rows));
    }
  });

  it("emits the pre-swap order for non-canonical and malformed stamps too", () => {
    for (const rows of nonCanonicalCorpus()) {
      expect(sortPinnedThreadsByOrderKey(rows)).toEqual(legacySortPinnedThreadsByOrderKey(rows));
    }
  });

  it("sinks a malformed stamp to the bottom instead of floating it to the top", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      { id: "malformed", createdAt: "unknown" },
      { id: "old", createdAt: "2020-01-01T00:00:00.000Z" },
      { id: "new", createdAt: "2026-03-09T12:00:00.000Z" },
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["new", "old", "malformed"]);
  });

  it("orders a seconds-precision stamp chronologically against a millisecond one", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      // 'Z' (0x5A) sorts above '.' (0x2E), so a raw string compare would call
      // the seconds-precision stamp the newer of the two.
      { id: "no-millis", createdAt: "2026-03-09T10:00:00Z" },
      { id: "with-millis", createdAt: "2026-03-09T10:00:00.999Z" },
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["with-millis", "no-millis"]);
  });

  it("orders offset forms by the instant, not by the local digits", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      // 05:00-05:00 is 10:00Z — one hour AFTER the 09:00Z row, though its
      // local digits read earlier.
      { id: "offset", createdAt: "2026-03-09T05:00:00.000-05:00" },
      { id: "utc", createdAt: "2026-03-09T09:00:00.000Z" },
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["offset", "utc"]);
  });

  it("refuses the fast path for stamps shaped right but naming no real date", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      // V8 rolls Feb 30 forward to Mar 2, so the string order and the instant
      // order disagree — the guard has to send this pair down the parse path.
      { id: "rolls-over", createdAt: "2026-02-30T10:00:00.000Z" },
      { id: "march-first", createdAt: "2026-03-01T10:00:00.000Z" },
      // No month 13: unparseable, so it keeps sinking to the epoch.
      { id: "unparseable", createdAt: "2026-13-09T10:00:00.000Z" },
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["rolls-over", "march-first", "unparseable"]);
  });

  it("keeps keyed threads ahead of keyless ones and orders keyless newest first", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      { id: "keyless-old", createdAt: "2026-03-09T08:00:00.000Z" },
      { id: "keyed", createdAt: "2020-01-01T00:00:00.000Z", pinOrderKey: "m" },
      { id: "keyless-new", createdAt: "2026-03-09T12:00:00.000Z" },
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["keyed", "keyless-new", "keyless-old"]);
  });

  it("falls back to id then environmentId when two keyless threads share a stamp", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      { id: "b", createdAt: "2026-03-09T10:00:00.000Z", environmentId: "env-a" },
      { id: "a", createdAt: "2026-03-09T10:00:00.000Z", environmentId: "env-b" },
      { id: "a", createdAt: "2026-03-09T10:00:00.000Z", environmentId: "env-a" },
    ]);

    expect(sorted.map((thread) => `${thread.id}@${thread.environmentId}`)).toEqual([
      "a@env-a",
      "a@env-b",
      "b@env-a",
    ]);
  });
});
