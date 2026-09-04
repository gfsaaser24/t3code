/**
 * T3 Turbo (fork-owned): SQL-vs-TS equivalence for the canonical activity order.
 *
 * Four shipped ORDER BY clauses claim to emit the same total order as the one
 * canonical comparator in
 * `packages/client-runtime/src/state/threadActivityOrder.ts`. They are four
 * hand-written copies of the same intent, in two files, and the review that
 * produced this test found two of them silently missing the lifecycle CASE and
 * all four disagreeing with the comparator on where an un-sequenced row goes.
 *
 * The guard is two-sided:
 *  - each clause below must literally appear in the file that ships it (so a
 *    future edit to any one copy fails HERE, not in a rendered thread), and
 *  - each clause, run against a generated corpus in a real SQLite, must return
 *    exactly `sortThreadActivities(corpus)`.
 *
 * The comparator is imported by relative path on purpose: `apps/server` does
 * not depend on `@t3tools/client-runtime`, and adding a package dependency to
 * an upstream-owned manifest just to reach one pure comparator is more rebase
 * surface than this import is.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { sortThreadActivities } from "../../../../packages/client-runtime/src/state/threadActivityOrder.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO_ROOT = NodePath.resolve(HERE, "../../../..");

const SNAPSHOT_QUERY_PATH = NodePath.join(
  REPO_ROOT,
  "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts",
);
const THREAD_ACTIVITIES_PATH = NodePath.join(
  REPO_ROOT,
  "apps/server/src/persistence/Layers/ProjectionThreadActivities.ts",
);

/** The lifecycle CASE, verbatim in every shipped clause. */
const LIFECYCLE_CASE = `CASE
            WHEN kind LIKE '%.started' THEN 0
            WHEN kind LIKE '%.completed' OR kind LIKE '%.resolved' THEN 2
            ELSE 1
          END ASC`;

const NULL_SEQUENCE_CASE = `CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC`;

interface ShippedClause {
  /** The `SqlSchema` binding that carries it, for failure messages. */
  readonly query: string;
  readonly sourcePath: string;
  /** Terms after `ORDER BY`, exactly as the source spells them. */
  readonly orderBy: string;
}

const SHIPPED_CLAUSES: ReadonlyArray<ShippedClause> = [
  {
    query: "listThreadActivityRows",
    sourcePath: SNAPSHOT_QUERY_PATH,
    orderBy: `thread_id ASC,
          ${NULL_SEQUENCE_CASE},
          sequence ASC,
          created_at ASC,
          ${LIFECYCLE_CASE},
          activity_id ASC`,
  },
  {
    query: "listThreadActivityRowsByThread",
    sourcePath: SNAPSHOT_QUERY_PATH,
    orderBy: `${NULL_SEQUENCE_CASE},
          sequence ASC,
          created_at ASC,
          ${LIFECYCLE_CASE},
          activity_id ASC`,
  },
  {
    query: "listThreadActivityRowsByThreadWindow",
    sourcePath: SNAPSHOT_QUERY_PATH,
    orderBy: `${NULL_SEQUENCE_CASE},
          sequence ASC,
          created_at ASC,
          ${LIFECYCLE_CASE},
          activity_id ASC`,
  },
  {
    query: "listProjectionThreadActivityRows",
    sourcePath: THREAD_ACTIVITIES_PATH,
    orderBy: `${NULL_SEQUENCE_CASE},
          sequence ASC,
          created_at ASC,
          ${LIFECYCLE_CASE},
          activity_id ASC`,
  },
];

/** Deterministic LCG — same generator the Wave 1 equivalence corpora use, so a
 *  failing corpus can be reproduced from a seed alone. `Math.imul` is
 *  load-bearing: plain multiplication overflows 2^53 and collapses the cycle. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state % 2147483648) / 2147483648;
  };
}

/**
 * A corpus built to hit every tiebreak in the comparator at least once:
 * un-sequenced rows interleaved with numbered ones, repeated sequences,
 * repeated `created_at` (so the lifecycle rank has to decide), every lifecycle
 * suffix including the unknown-kind fallthrough, and ids whose code-unit order
 * disagrees with `localeCompare` (uppercase vs lowercase).
 */
function corpus(): ReadonlyArray<OrchestrationThreadActivity> {
  const random = makeRandom(0x4d19b7f);
  const kinds = [
    "tool.started",
    "tool.progress",
    "tool.completed",
    "approval.requested",
    "approval.resolved",
    "task.started",
    "context-window.updated",
    // Un-numbered live emitters, the population this whole convention is about.
    "checkpoint.captured",
    "checkpoint.capture.failed",
    "session.started",
  ];
  const createdAts = [
    "2026-08-09T12:00:00.000Z",
    "2026-08-09T12:00:00.000Z",
    "2026-08-09T12:00:00.001Z",
    "2026-08-09T12:00:01.000Z",
    "2026-08-09T11:59:59.999Z",
  ];
  // Mixed case AND digit-vs-letter, the two places BINARY and ICU disagree.
  const idPrefixes = ["a", "A", "z", "Z", "0", "9", "m"];

  const rows: OrchestrationThreadActivity[] = [];
  for (let index = 0; index < 400; index += 1) {
    const kind = kinds[Math.floor(random() * kinds.length)]!;
    // ~30% un-sequenced, and sequences repeat so (sequence, created_at) ties
    // are common rather than incidental.
    const sequence = random() < 0.3 ? undefined : Math.floor(random() * 12);
    rows.push({
      id: `${idPrefixes[Math.floor(random() * idPrefixes.length)]!}-act-${String(index).padStart(3, "0")}`,
      kind,
      tone: "info",
      summary: kind,
      payload: null,
      turnId: null,
      createdAt: createdAts[Math.floor(random() * createdAts.length)]!,
      ...(sequence === undefined ? {} : { sequence }),
    } as unknown as OrchestrationThreadActivity);
  }
  return rows;
}

/** Whitespace-insensitive containment: the sources indent inside a template
 *  literal, and `pnpm fmt` is allowed to reflow that indentation. */
function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("thread activity order — SQL vs TS equivalence", (it) => {
  it("ships each ORDER BY clause verbatim in its source file", () => {
    for (const clause of SHIPPED_CLAUSES) {
      const source = NodeFS.readFileSync(clause.sourcePath, "utf8");
      assert.include(
        normalize(source),
        normalize(`ORDER BY ${clause.orderBy}`),
        `${clause.query} no longer ships the canonical ORDER BY — update the clause here and re-run, or the four copies have drifted apart`,
      );
    }
  });

  it.effect("returns sortThreadActivities' order under every shipped clause", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = corpus();

      // The real column set and types, minus the FKs the ordering never reads.
      yield* sql`
        CREATE TABLE projection_thread_activities (
          activity_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          tone TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          sequence INTEGER,
          created_at TEXT NOT NULL
        )
      `;

      for (const row of rows) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES (
            ${row.id},
            ${"thread-1"},
            ${null},
            ${row.tone},
            ${row.kind},
            ${row.summary},
            ${"null"},
            ${row.sequence ?? null},
            ${row.createdAt}
          )
        `;
      }

      const expected = sortThreadActivities(rows).map((row) => row.id);

      for (const clause of SHIPPED_CLAUSES) {
        // Every row carries the same thread_id, so a leading `thread_id ASC`
        // is a no-op here and the terms under test are the ones that decide.
        const read = yield* sql.unsafe<{ readonly activity_id: string }>(
          `SELECT activity_id FROM projection_thread_activities ORDER BY ${clause.orderBy}`,
        );
        assert.deepStrictEqual(
          read.map((row) => row.activity_id),
          expected,
          `${clause.query} disagrees with sortThreadActivities`,
        );
      }
    }),
  );
});
