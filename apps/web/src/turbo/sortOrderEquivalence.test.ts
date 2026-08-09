/**
 * T3 Turbo (fork-owned): order-equivalence evidence for the Wave 1 sort work.
 *
 * Two speedups shipped together, and both are only allowed to be faster — the
 * emitted order has to stay byte-identical to what shipped before:
 *  - W4 swapped `localeCompare` for code-unit comparison on timestamps.
 *  - W10 turned the sidebar bucket sorts into decorate-sort.
 *
 * Each is pinned here against a reference implementation copied verbatim from
 * the pre-change code, so a later edit that shifts an order (including a tie)
 * fails in this file rather than in the sidebar.
 */
import type { OrchestrationLatestTurn } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  firstValidTimestampMs,
  parseTimestampMs,
  resolveSettledTimestamp,
  sortSettledThreadsForSidebar,
  sortSnoozedThreadsForSidebar,
  sortThreadsForSidebar,
} from "../components/Sidebar.logic";
import { compareIsoTimestamps } from "@t3tools/client-runtime/state/thread-activity-order";

/** Deterministic LCG: the corpora must be identical on every machine.
 *  `Math.imul` is load-bearing: `state * 1103515245` overflows 2^53, and the
 *  float rounding that follows collapses the generator to a ~10k-value cycle.
 *  Shared constants with the twin generator in
 *  `packages/client-runtime/src/state/threadSortPinnedKeyless.test.ts` — keep
 *  the two identical so a corpus can be reproduced from either file. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state % 2147483648) / 2147483648;
  };
}

/** Timestamps minted the only way the product mints them: `toISOString()`,
    which is exactly what effect's `DateTime.formatIso` returns. */
function isoCorpus(): string[] {
  const random = makeRandom(0x2f6e2b1);
  const values: string[] = [];
  for (let index = 0; index < 300; index += 1) {
    // 1970-01-01 .. 2100-01-01, so the year/month/day fields all vary.
    values.push(new Date(Math.floor(random() * 4102444800000)).toISOString());
  }
  // Near-collisions that isolate every field boundary in turn.
  const anchor = Date.UTC(2026, 7, 9, 12, 0, 0, 0);
  for (const delta of [
    -31_536_000_000, -86_400_000, -3_600_000, -60_000, -1_000, -1, 0, 1, 1_000, 60_000, 3_600_000,
    86_400_000, 31_536_000_000,
  ]) {
    values.push(new Date(anchor + delta).toISOString());
  }
  values.push(new Date(0).toISOString());
  return values;
}

describe("compareIsoTimestamps (W4)", () => {
  it("orders every pair of product-minted timestamps exactly as localeCompare did", () => {
    const values = isoCorpus();
    const disagreements: Array<{ left: string; right: string }> = [];
    for (const left of values) {
      for (const right of values) {
        if (Math.sign(compareIsoTimestamps(left, right)) !== Math.sign(left.localeCompare(right))) {
          disagreements.push({ left, right });
        }
      }
    }
    // ~98k pairs: the first code unit that differs is always a digit at the
    // same index in both operands, which is why the two agree.
    expect(disagreements).toEqual([]);
  });

  it("matches chronological order and reports 0 only for identical stamps", () => {
    // Collected, not asserted per pair: ~98k individual expects over the same
    // pair space costs seconds and reports one failure at a time.
    const values = isoCorpus();
    const disagreements: Array<{ left: string; right: string }> = [];
    for (const left of values) {
      for (const right of values) {
        if (
          Math.sign(compareIsoTimestamps(left, right)) !==
          Math.sign(Date.parse(left) - Date.parse(right))
        ) {
          disagreements.push({ left, right });
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});

describe("sortThreadsForSidebar (W10 active bucket)", () => {
  type Row = { readonly id: string; readonly createdAt: string };

  /** Pre-decorate implementation: parses both operands on every comparison. */
  function legacySort(threads: readonly Row[]): Row[] {
    return [...threads].toSorted(
      (left, right) =>
        parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }

  function corpus(): Row[][] {
    const random = makeRandom(0x51ed270b);
    const stamps = [
      "2026-03-09T10:00:00.000Z",
      "2026-03-09T10:00:00.001Z",
      "2026-03-09T09:00:00.000Z",
      "2025-12-31T23:59:59.999Z",
      // Deliberately unparseable: the epoch sink must survive the rewrite.
      "not-a-timestamp",
    ];
    // Ids repeat on purpose so timestamp ties AND id ties both occur.
    const ids = ["a", "b", "c", "A", "a"];
    const batches: Row[][] = [];
    for (let batch = 0; batch < 60; batch += 1) {
      const size = 2 + Math.floor(random() * 8);
      const rows: Row[] = [];
      for (let index = 0; index < size; index += 1) {
        rows.push({
          id: ids[Math.floor(random() * ids.length)]!,
          createdAt: stamps[Math.floor(random() * stamps.length)]!,
        });
      }
      batches.push(rows);
    }
    return batches;
  }

  it("emits the pre-decorate order, ties included", () => {
    for (const rows of corpus()) {
      expect(sortThreadsForSidebar(rows)).toEqual(legacySort(rows));
    }
  });

  it("keeps input order for rows that tie on both timestamp and id", () => {
    const first = { id: "same", createdAt: "2026-03-09T10:00:00.000Z", marker: 1 };
    const second = { id: "same", createdAt: "2026-03-09T10:00:00.000Z", marker: 2 };
    expect(sortThreadsForSidebar([first, second]).map((row) => row.marker)).toEqual([1, 2]);
    expect(sortThreadsForSidebar([second, first]).map((row) => row.marker)).toEqual([2, 1]);
  });

  it("does not mutate the input array", () => {
    const rows: Row[] = [
      { id: "old", createdAt: "2026-03-09T09:00:00.000Z" },
      { id: "new", createdAt: "2026-03-09T10:00:00.000Z" },
    ];
    sortThreadsForSidebar(rows);
    expect(rows.map((row) => row.id)).toEqual(["old", "new"]);
  });
});

describe("sortSettledThreadsForSidebar (W10 settled bucket)", () => {
  type Row = {
    readonly id: string;
    readonly settledAt: string | null;
    readonly latestUserMessageAt: string | null;
    readonly latestTurn: OrchestrationLatestTurn | null;
    readonly updatedAt: string;
  };

  /** Pre-decorate implementation: re-walks all four candidates per comparison. */
  function legacySort(threads: readonly Row[]): Row[] {
    const timestampMs = (thread: Row) => {
      const timestamp = resolveSettledTimestamp(thread);
      return timestamp === null ? 0 : Date.parse(timestamp);
    };
    return [...threads].toSorted(
      (left, right) => timestampMs(right) - timestampMs(left) || left.id.localeCompare(right.id),
    );
  }

  function makeTurn(
    requestedAt: string,
    startedAt: string | null,
    completedAt: string | null,
  ): OrchestrationLatestTurn {
    return {
      turnId: "turn-1" as never,
      state: "completed",
      assistantMessageId: null,
      requestedAt,
      startedAt,
      completedAt,
    };
  }

  function corpus(): Row[][] {
    const random = makeRandom(0x6b3f11d);
    const stamps: Array<string | null> = [
      null,
      "2026-03-09T10:00:00.000Z",
      "2026-03-09T10:00:00.000Z",
      "2026-03-09T11:30:00.000Z",
      "2026-03-08T22:15:00.000Z",
      "definitely-not-a-timestamp",
    ];
    const pick = () => stamps[Math.floor(random() * stamps.length)] ?? null;
    const ids = ["alpha", "beta", "Alpha", "alpha"];
    const batches: Row[][] = [];
    for (let batch = 0; batch < 60; batch += 1) {
      const size = 2 + Math.floor(random() * 8);
      const rows: Row[] = [];
      for (let index = 0; index < size; index += 1) {
        rows.push({
          id: ids[Math.floor(random() * ids.length)]!,
          settledAt: pick(),
          latestUserMessageAt: pick(),
          latestTurn: random() < 0.5 ? null : makeTurn("2026-03-09T09:00:00.000Z", pick(), pick()),
          updatedAt: pick() ?? "2026-03-09T08:00:00.000Z",
        });
      }
      batches.push(rows);
    }
    return batches;
  }

  it("emits the pre-decorate order, ties included", () => {
    for (const rows of corpus()) {
      expect(sortSettledThreadsForSidebar(rows)).toEqual(legacySort(rows));
    }
  });

  it("resolves each row's settle timestamp exactly once per sort", () => {
    // The point of decorating: the resolve walk goes from O(n log n) to O(n).
    // `updatedAt` is the last candidate resolveSettledTimestamp consults for a
    // row with nothing else set, so a getter on it counts resolve calls.
    let reads = 0;
    const rows = Array.from({ length: 16 }, (_unused, index) => ({
      id: `thread-${index}`,
      settledAt: null,
      latestUserMessageAt: null,
      latestTurn: null,
      get updatedAt() {
        reads += 1;
        return `2026-03-09T10:00:${String(index).padStart(2, "0")}.000Z`;
      },
    }));

    const sorted = sortSettledThreadsForSidebar(rows);

    expect(reads).toBe(rows.length);
    expect(sorted[0]?.id).toBe("thread-15");
  });
});

describe("sortSnoozedThreadsForSidebar (snoozed shelf)", () => {
  type Row = { readonly id: string; readonly snoozedUntil?: string | null | undefined };

  /** The comparator as it stood inline in Sidebar.tsx, verbatim. */
  function legacySort(threads: readonly Row[]): Row[] {
    return threads.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.snoozedUntil ?? null) -
        firstValidTimestampMs(right.snoozedUntil ?? null),
    );
  }

  function corpus(): Row[][] {
    const random = makeRandom(0x3ac91f5);
    const wakes: Array<string | null | undefined> = [
      null,
      undefined,
      "2026-03-09T10:00:00.000Z",
      "2026-03-09T10:00:00.000Z",
      "2026-03-09T11:30:00.000Z",
      "2026-03-08T22:15:00.000Z",
      // Malformed: firstValidTimestampMs falls through to 0, same as absent.
      "wake-me-up-inside",
    ];
    const ids = ["alpha", "beta", "Alpha", "alpha"];
    const batches: Row[][] = [];
    for (let batch = 0; batch < 60; batch += 1) {
      const size = 2 + Math.floor(random() * 8);
      const rows: Row[] = [];
      for (let index = 0; index < size; index += 1) {
        rows.push({
          id: `${ids[Math.floor(random() * ids.length)]!}-${index}`,
          snoozedUntil: wakes[Math.floor(random() * wakes.length)],
        });
      }
      batches.push(rows);
    }
    return batches;
  }

  it("emits the pre-decorate order, ties included", () => {
    for (const rows of corpus()) {
      expect(sortSnoozedThreadsForSidebar(rows)).toEqual(legacySort(rows));
    }
  });

  it("resolves each row's wake time exactly once per sort", () => {
    let reads = 0;
    const rows = Array.from({ length: 16 }, (_unused, index) => ({
      id: `thread-${index}`,
      get snoozedUntil() {
        reads += 1;
        return `2026-03-09T10:00:${String(index).padStart(2, "0")}.000Z`;
      },
    }));

    const sorted = sortSnoozedThreadsForSidebar(rows);

    expect(reads).toBe(rows.length);
    expect(sorted[0]?.id).toBe("thread-0");
  });

  it("does not mutate the input array", () => {
    const rows: Row[] = [
      { id: "later", snoozedUntil: "2026-03-09T12:00:00.000Z" },
      { id: "sooner", snoozedUntil: "2026-03-09T09:00:00.000Z" },
    ];
    sortSnoozedThreadsForSidebar(rows);
    expect(rows.map((row) => row.id)).toEqual(["later", "sooner"]);
  });
});
