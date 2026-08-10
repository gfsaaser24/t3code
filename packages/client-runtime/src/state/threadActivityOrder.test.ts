/**
 * T3 Turbo (fork-owned): the unified activity comparator (Wave 2, W2+W3).
 *
 * Four surfaces used to sort activities four different ways — the store, the
 * web view layer, mobile, and the server SQL — and they disagreed on where
 * rows without a `sequence` go and on lifecycle order for ties. Deleting the
 * per-derivation re-sorts on top of that divergence is what could have made an
 * approval's `.resolved` row land before its `.requested` row and painted a
 * phantom pending-approval badge. This file pins the properties that made the
 * deletion safe.
 */
import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  activityLifecycleRank,
  compareIsoTimestamps,
  compareThreadActivities,
  sortThreadActivities,
} from "./threadActivityOrder.ts";

const DEFAULT_CREATED_AT = "2026-08-09T12:00:00.000Z";

function activity(
  id: string,
  kind: string,
  overrides: { readonly sequence?: number; readonly createdAt?: string } = {},
): OrchestrationThreadActivity {
  return {
    id,
    kind,
    tone: "info",
    summary: kind,
    payload: null,
    turnId: null,
    createdAt: overrides.createdAt ?? DEFAULT_CREATED_AT,
    ...(overrides.sequence === undefined ? {} : { sequence: overrides.sequence }),
  } as unknown as OrchestrationThreadActivity;
}

describe("compareThreadActivities — the missing-sequence convention", () => {
  it("sorts un-sequenced rows after every numbered row", () => {
    // A missing sequence does NOT mean "oldest". Only
    // ProviderRuntimeIngestion numbers what it emits; CheckpointReactor,
    // ws.ts's setup scripts and ProviderCommandReactor's error rows all append
    // un-sequenced activities on LIVE threads. MAX_SAFE_INTEGER sinks them,
    // which is what the store reducer and mobile always did and therefore what
    // the rendered thread timeline has always shown.
    const unsequenced = activity("a-unsequenced", "tool.started");
    const numbered = activity("b-numbered", "tool.started", { sequence: 0 });

    expect(compareThreadActivities(unsequenced, numbered)).toBe(1);
    expect(compareThreadActivities(numbered, unsequenced)).toBe(-1);
    expect(sortThreadActivities([unsequenced, numbered]).map((row) => row.id)).toEqual([
      "b-numbered",
      "a-unsequenced",
    ]);
  });

  it("keeps a live checkpoint row at the END of a mixed thread", () => {
    // The regression this convention exists to prevent: every turn's
    // "Checkpoint captured" row is emitted with no sequence, so under a
    // missing-FIRST convention it hoists itself above the thread's very first
    // provider row.
    const window: ReadonlyArray<OrchestrationThreadActivity> = [
      activity("checkpoint-1", "checkpoint.captured", {
        createdAt: "2026-08-09T12:00:09.000Z",
      }),
      activity("a-started", "tool.started", { sequence: 1 }),
      activity("b-completed", "tool.completed", { sequence: 2 }),
    ];

    expect(sortThreadActivities(window).map((row) => row.id)).toEqual([
      "a-started",
      "b-completed",
      "checkpoint-1",
    ]);
  });

  it("falls through to createdAt when both rows are un-sequenced", () => {
    const earlier = activity("z-earlier", "tool.started", { createdAt: DEFAULT_CREATED_AT });
    const later = activity("a-later", "tool.started", {
      createdAt: "2026-08-09T12:00:01.000Z",
    });

    expect(sortThreadActivities([later, earlier]).map((row) => row.id)).toEqual([
      "z-earlier",
      "a-later",
    ]);
  });
});

describe("compareThreadActivities — the phantom pending-approval hazard", () => {
  // Deliberately the LATER id on the requested row: an id-only tiebreak (what
  // the store's comparator did before this task) inverts this pair.
  const requested = activity("zzz-requested", "approval.requested");
  const resolved = activity("aaa-resolved", "approval.resolved");

  it("keeps resolved after requested when the pair ties on sequence and createdAt", () => {
    expect(compareThreadActivities(requested, resolved)).toBe(-1);
    expect(sortThreadActivities([resolved, requested]).map((row) => row.id)).toEqual([
      "zzz-requested",
      "aaa-resolved",
    ]);
  });

  it("keeps resolved after requested when both rows carry the same sequence", () => {
    const tiedRequested = activity("zzz-requested", "approval.requested", { sequence: 7 });
    const tiedResolved = activity("aaa-resolved", "approval.resolved", { sequence: 7 });

    expect(sortThreadActivities([tiedResolved, tiedRequested]).map((row) => row.id)).toEqual([
      "zzz-requested",
      "aaa-resolved",
    ]);
  });

  it("keeps resolved after requested through the full pipeline order", () => {
    // Every stage of the pipeline — the store's append-and-sort, the
    // older-page merge's sort, and the view layer's single boundary sort — now
    // runs this one comparator, so a shuffled window has to converge on the
    // same array whichever stage sees it.
    const window: ReadonlyArray<OrchestrationThreadActivity> = [
      activity("d-resolved", "approval.resolved", { sequence: 4 }),
      activity("c-requested", "approval.requested", { sequence: 4 }),
      activity("unsequenced-1", "session.started"),
      activity("b-completed", "tool.completed", { sequence: 1 }),
      activity("a-started", "tool.started", { sequence: 1 }),
    ];

    const ids = sortThreadActivities(window).map((row) => row.id);

    expect(ids).toEqual(["a-started", "b-completed", "c-requested", "d-resolved", "unsequenced-1"]);
    // Sorting an already-sorted window is idempotent: the boundary sort cannot
    // shuffle what the store handed it.
    expect(sortThreadActivities(sortThreadActivities(window)).map((row) => row.id)).toEqual(ids);
  });
});

describe("compareThreadActivities — the id tiebreak", () => {
  it("compares ids by code unit, the way the server's activity_id ASC does", () => {
    // SQLite's default BINARY collation compares UTF-8 bytes, so uppercase
    // sorts before lowercase. `localeCompare` does the opposite for this pair,
    // which would have left the client and the SQL on different total orders.
    const upper = activity("Z-upper", "tool.completed", { sequence: 3 });
    const lower = activity("a-lower", "tool.completed", { sequence: 3 });

    expect("Z-upper" < "a-lower").toBe(true);
    expect(compareThreadActivities(upper, lower)).toBe(-1);
    expect(sortThreadActivities([lower, upper]).map((row) => row.id)).toEqual([
      "Z-upper",
      "a-lower",
    ]);
  });

  it("returns 0 only for rows that agree on every key", () => {
    const row = activity("same-id", "tool.completed", { sequence: 3 });

    expect(compareThreadActivities(row, { ...row })).toBe(0);
  });
});

describe("activityLifecycleRank", () => {
  it("ranks started before progress/updated before completed/resolved", () => {
    expect(activityLifecycleRank("tool.started")).toBe(0);
    expect(activityLifecycleRank("task.started")).toBe(0);
    expect(activityLifecycleRank("tool.progress")).toBe(1);
    expect(activityLifecycleRank("context-window.updated")).toBe(1);
    expect(activityLifecycleRank("tool.completed")).toBe(2);
    expect(activityLifecycleRank("approval.resolved")).toBe(2);
    // Unknown kinds land in the middle, exactly as the pre-unification web and
    // mobile helpers did.
    expect(activityLifecycleRank("checkpoint.captured")).toBe(1);
  });
});

describe("compareIsoTimestamps", () => {
  it("agrees with localeCompare on fixed-width product timestamps", () => {
    expect(compareIsoTimestamps("2026-08-09T12:00:00.000Z", "2026-08-09T12:00:01.000Z")).toBe(-1);
    expect(compareIsoTimestamps("2026-08-09T12:00:01.000Z", "2026-08-09T12:00:00.000Z")).toBe(1);
    expect(compareIsoTimestamps(DEFAULT_CREATED_AT, DEFAULT_CREATED_AT)).toBe(0);
  });
});
