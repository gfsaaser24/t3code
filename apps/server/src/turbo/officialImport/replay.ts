import * as NodeServices from "@effect/platform-node/NodeServices";
import { NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as ServerConfig from "../../config.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";

const ProjectionCursorRow = Schema.Struct({
  projector: Schema.String,
  lastAppliedSequence: NonNegativeInt,
  maxSequence: NonNegativeInt,
});

export class OfficialImportProjectionVerificationError extends Schema.TaggedErrorClass<OfficialImportProjectionVerificationError>()(
  "OfficialImportProjectionVerificationError",
  {
    expectedProjectors: Schema.Array(Schema.String),
    incompleteProjectors: Schema.Array(Schema.String),
    maxSequence: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Imported projections did not reach event sequence ${this.maxSequence}: ${this.incompleteProjectors.join(", ")}.`;
  }
}

export class OfficialImportProjectionReplayError extends Schema.TaggedErrorClass<OfficialImportProjectionReplayError>()(
  "OfficialImportProjectionReplayError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Failed to rebuild imported projections: ${this.reason}`;
  }
}

export interface RebuildOfficialImportProjectionsInput {
  readonly databasePath: string;
  /** Empty, disposable T3 base directory used for attachment side effects during replay. */
  readonly sandboxBaseDir: string;
}

/**
 * Rebuild and verify every derived orchestration projection in an import staging database.
 *
 * The caller clears derived rows before invoking this function. The real source and destination
 * homes are deliberately not provided to the projector: any attachment cleanup caused by replay
 * is contained inside `sandboxBaseDir` until the import has otherwise been verified.
 */
export const rebuildOfficialImportProjections = Effect.fn("rebuildOfficialImportProjections")(
  function* (input: RebuildOfficialImportProjectionsInput) {
    const persistenceLayer = makeSqlitePersistenceLive(input.databasePath);
    const runtimeLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.sandboxBaseDir)),
      Layer.provideMerge(persistenceLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* projectionPipeline.bootstrap;

      const readCursors = SqlSchema.findAll({
        Request: Schema.Void,
        Result: ProjectionCursorRow,
        execute: () => sql`
        SELECT
          projection_state.projector AS "projector",
          projection_state.last_applied_sequence AS "lastAppliedSequence",
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS "maxSequence"
        FROM projection_state
      `,
      });
      const cursors = yield* readCursors(undefined);
      const expectedProjectors = Object.values(ORCHESTRATION_PROJECTOR_NAMES);
      const maxSequence = cursors.at(0)?.maxSequence ?? 0;
      const cursorByProjector = new Map(
        cursors.map((cursor) => [cursor.projector, cursor.lastAppliedSequence] as const),
      );
      const incompleteProjectors = expectedProjectors.filter(
        (projector) => cursorByProjector.get(projector) !== maxSequence,
      );

      if (incompleteProjectors.length > 0) {
        return yield* new OfficialImportProjectionVerificationError({
          expectedProjectors,
          incompleteProjectors,
          maxSequence,
        });
      }
    }).pipe(
      Effect.provide(runtimeLayer),
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new OfficialImportProjectionReplayError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
  },
);
