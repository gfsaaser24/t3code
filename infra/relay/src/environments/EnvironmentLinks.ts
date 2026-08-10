import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayManagedEndpoint,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, isNull, or } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";
import {
  forgetTtlMemo,
  makeTtlMemo,
  readTtlMemo,
  writeTtlMemo,
  type TtlMemo,
} from "../turbo/ttlMemo.ts";

export interface RelayLinkedEnvironmentRecord extends RelayClientEnvironmentRecord {
  readonly environmentPublicKey: string;
}

export interface AgentAwarenessDeliveryUserRecord {
  readonly userId: string;
  readonly notificationsEnabled: boolean;
  readonly liveActivitiesEnabled: boolean;
}

export class EnvironmentLinkUpsertPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkUpsertPersistenceError>()(
  "EnvironmentLinkUpsertPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    deviceId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkUserListPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkUserListPersistenceError>()(
  "EnvironmentLinkUserListPersistenceError",
  {
    operation: Schema.Literals(["list-users", "list-delivery-users"]),
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment link user query '${this.operation}' failed for environment '${this.environmentId}'`;
  }
}

export class EnvironmentPublicKeyListPersistenceError extends Schema.TaggedErrorClass<EnvironmentPublicKeyListPersistenceError>()(
  "EnvironmentPublicKeyListPersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list public keys for environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkListPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkListPersistenceError>()(
  "EnvironmentLinkListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list environment links for user '${this.userId}'`;
  }
}

export class EnvironmentLinkLookupPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkLookupPersistenceError>()(
  "EnvironmentLinkLookupPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to look up environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkRevokePersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkRevokePersistenceError>()(
  "EnvironmentLinkRevokePersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinks extends Context.Service<
  EnvironmentLinks,
  {
    readonly upsert: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkRequest;
      readonly proof: RelayEnvironmentLinkProofPayload;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<void, EnvironmentLinkUpsertPersistenceError>;
    readonly listUsersForEnvironment: (input: {
      readonly environmentId: string;
    }) => Effect.Effect<ReadonlyArray<string>, EnvironmentLinkUserListPersistenceError>;
    readonly listDeliveryUsersForEnvironment: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<
      ReadonlyArray<AgentAwarenessDeliveryUserRecord>,
      EnvironmentLinkUserListPersistenceError
    >;
    readonly listPublicKeysForEnvironment: (input: {
      readonly environmentId: string;
    }) => Effect.Effect<ReadonlyArray<string>, EnvironmentPublicKeyListPersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayClientEnvironmentRecord>,
      EnvironmentLinkListPersistenceError
    >;
    readonly getForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
      // Read past the memo, and do not populate it from this read. Mandatory for any caller that
      // DECIDES A WRITE from what it reads: the record carries `environmentPublicKey`, and a
      // remembered pre-rotation key would make the deciding caller revoke the previous credential
      // while the current one stays authenticated. Status/list/connect reads stay memoized --
      // staleness only delays their answer.
      readonly bypassMemo?: boolean;
    }) => Effect.Effect<RelayLinkedEnvironmentRecord | null, EnvironmentLinkLookupPersistenceError>;
    readonly revokeForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<boolean, EnvironmentLinkRevokePersistenceError>;
  }
>()("t3code-relay/environments/EnvironmentLinks") {}

function agentAwarenessDeliveryUserCondition(environmentId: string) {
  return and(
    eq(relayEnvironmentLinks.environmentId, environmentId),
    isNull(relayEnvironmentLinks.revokedAt),
    or(
      eq(relayEnvironmentLinks.notificationsEnabled, true),
      eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
    ),
  );
}

function agentAwarenessDeliveryUserKeyCondition(input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  return and(
    agentAwarenessDeliveryUserCondition(input.environmentId),
    eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
  );
}

// The user-link lookups are nearly static and front the status, connect, and list paths, so a
// very short in-isolate memo removes one of the two database trips those requests make. The
// window is the whole safety argument: an unlink is reflected within
// ENVIRONMENT_LINK_LOOKUP_TTL_MS at worst. Two neighbouring lookups are deliberately NOT
// cached, because staleness changes their answer rather than delaying it:
// ManagedEndpointAllocations.get carries the compare-and-swap token that detects a racing
// provision during unlink, and EnvironmentCredentials.authenticate is the instant-revocation
// enforcement point.
const ENVIRONMENT_LINK_LOOKUP_TTL_MS = 5_000;
const ENVIRONMENT_LINK_LOOKUP_LIMIT = 1_024;

function linkRecordMemoKey(input: {
  readonly userId: string;
  readonly environmentId: string;
}): string {
  return `${input.userId}\u0000${input.environmentId}`;
}

// Dropping a key is not enough on its own. Both writers below run inside an open transaction
// (`revokeForUser` is wrapped by `transactions.withTransaction` in the API layer), so a read that
// lands between the drop and the commit still sees the PRE-write row and would re-cache it for a
// full TTL that outlives the commit. Every drop therefore also raises a barrier on the key for the
// length of one TTL: reads still answer from the database, they just may not remember the answer
// while the barrier stands. This closes the interleave without needing a post-commit hook, and it
// fails in the safe direction -- a blocked key costs one query, never a stale answer.
type LinkLookupBarriers = TtlMemo<true>;

function blockLinkLookup(barriers: LinkLookupBarriers, key: string, nowMs: number): void {
  writeTtlMemo(barriers, key, true, nowMs + ENVIRONMENT_LINK_LOOKUP_TTL_MS, nowMs);
}

function isLinkLookupBlocked(barriers: LinkLookupBarriers, key: string, nowMs: number): boolean {
  return readTtlMemo(barriers, key, nowMs) !== null;
}

// Only positive answers are remembered, and only while no barrier stands on the key. A missing
// link is the answer that a fresh link has to overturn, and re-reading it costs one query on a
// path that is not hot.
function rememberLinkLookup<A>(
  memo: TtlMemo<A>,
  barriers: LinkLookupBarriers,
  key: string,
  value: A,
  nowMs: number,
): void {
  if (isLinkLookupBlocked(barriers, key, nowMs)) {
    return;
  }
  writeTtlMemo(memo, key, value, nowMs + ENVIRONMENT_LINK_LOOKUP_TTL_MS, nowMs);
}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const linkListMemo = makeTtlMemo<ReadonlyArray<RelayClientEnvironmentRecord>>(
    ENVIRONMENT_LINK_LOOKUP_LIMIT,
  );
  const linkRecordMemo = makeTtlMemo<RelayLinkedEnvironmentRecord>(ENVIRONMENT_LINK_LOOKUP_LIMIT);
  // The two key spaces share one barrier map: a record key always contains the NUL separator that
  // `linkRecordMemoKey` inserts, so it can never collide with a bare user id.
  const linkLookupBarriers = makeTtlMemo<true>(ENVIRONMENT_LINK_LOOKUP_LIMIT);
  // Best effort only, for the isolate that performed the write: the TTL above, not this call,
  // is what bounds staleness everywhere else. The barrier is the part that survives an open
  // transaction -- see the comment on `blockLinkLookup`.
  const forgetLinkLookups = (
    input: {
      readonly userId: string;
      readonly environmentId: string;
    },
    nowMs: number,
  ): void => {
    forgetTtlMemo(linkListMemo, input.userId);
    forgetTtlMemo(linkRecordMemo, linkRecordMemoKey(input));
    blockLinkLookup(linkLookupBarriers, input.userId, nowMs);
    blockLinkLookup(linkLookupBarriers, linkRecordMemoKey(input), nowMs);
  };

  return EnvironmentLinks.of({
    upsert: Effect.fn("relay.environment_links.upsert")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.proof.environmentId,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const { request, proof } = input;
      const environmentId = proof.environmentId;
      const { endpoint } = input;
      yield* db
        .insert(relayEnvironmentLinks)
        .values({
          userId: input.userId,
          environmentId,
          environmentLabel: proof.descriptor.label,
          environmentPublicKey: proof.environmentPublicKey,
          endpointHttpBaseUrl: endpoint.httpBaseUrl,
          endpointWsBaseUrl: endpoint.wsBaseUrl,
          endpointProviderKind: endpoint.providerKind,
          notificationsEnabled: request.notificationsEnabled,
          liveActivitiesEnabled: request.liveActivitiesEnabled,
          managedTunnelsEnabled: request.managedTunnelsEnabled,
          createdByDeviceId: request.deviceId ?? null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [relayEnvironmentLinks.userId, relayEnvironmentLinks.environmentId],
          set: {
            environmentPublicKey: proof.environmentPublicKey,
            environmentLabel: proof.descriptor.label,
            endpointHttpBaseUrl: endpoint.httpBaseUrl,
            endpointWsBaseUrl: endpoint.wsBaseUrl,
            endpointProviderKind: endpoint.providerKind,
            notificationsEnabled: request.notificationsEnabled,
            liveActivitiesEnabled: request.liveActivitiesEnabled,
            managedTunnelsEnabled: request.managedTunnelsEnabled,
            createdByDeviceId: request.deviceId ?? null,
            revokedAt: null,
            updatedAt: now,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkUpsertPersistenceError({
                userId: input.userId,
                environmentId,
                ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
                cause,
              }),
          ),
        );
      forgetLinkLookups(
        { userId: input.userId, environmentId },
        DateTime.toEpochMillis(yield* DateTime.now),
      );
    }),

    listUsersForEnvironment: Effect.fn("relay.environment_links.list_users_for_environment")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
        return yield* db
          .select({ userId: relayEnvironmentLinks.userId })
          .from(relayEnvironmentLinks)
          .where(agentAwarenessDeliveryUserCondition(input.environmentId))
          .pipe(
            Effect.map((rows) => rows.map((row) => row.userId)),
            Effect.mapError(
              (cause) =>
                new EnvironmentLinkUserListPersistenceError({
                  operation: "list-users",
                  environmentId: input.environmentId,
                  cause,
                }),
            ),
          );
      },
    ),

    listDeliveryUsersForEnvironment: Effect.fn(
      "relay.environment_links.list_delivery_users_for_environment",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      return yield* db
        .select({
          userId: relayEnvironmentLinks.userId,
          notificationsEnabled: relayEnvironmentLinks.notificationsEnabled,
          liveActivitiesEnabled: relayEnvironmentLinks.liveActivitiesEnabled,
        })
        .from(relayEnvironmentLinks)
        .where(agentAwarenessDeliveryUserKeyCondition(input))
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              userId: row.userId,
              notificationsEnabled: row.notificationsEnabled,
              liveActivitiesEnabled: row.liveActivitiesEnabled,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkUserListPersistenceError({
                operation: "list-delivery-users",
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    listPublicKeysForEnvironment: Effect.fn(
      "relay.environment_links.list_public_keys_for_environment",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      return yield* db
        .select({ environmentPublicKey: relayEnvironmentLinks.environmentPublicKey })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.map((rows) => [
            ...new Set(rows.map((row) => row.environmentPublicKey).filter((key) => key.length > 0)),
          ]),
          Effect.mapError(
            (cause) =>
              new EnvironmentPublicKeyListPersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    listForUser: Effect.fn("relay.environment_links.list_for_user")(function* (input) {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const remembered = readTtlMemo(linkListMemo, input.userId, nowMs);
      yield* Effect.annotateCurrentSpan({ "relay.link_lookup.memo_hit": remembered !== null });
      if (remembered !== null) {
        return remembered;
      }
      const environments = yield* db
        .select({
          environmentId: relayEnvironmentLinks.environmentId,
          environmentLabel: relayEnvironmentLinks.environmentLabel,
          endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
          endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
          endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
          createdAt: relayEnvironmentLinks.createdAt,
        })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              environmentId: row.environmentId as RelayClientEnvironmentRecord["environmentId"],
              label:
                row.environmentLabel.trim().length > 0 ? row.environmentLabel : row.environmentId,
              endpoint: {
                httpBaseUrl: row.endpointHttpBaseUrl,
                wsBaseUrl: row.endpointWsBaseUrl,
                providerKind:
                  row.endpointProviderKind as RelayClientEnvironmentRecord["endpoint"]["providerKind"],
              },
              linkedAt: row.createdAt,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
      if (environments.length > 0) {
        rememberLinkLookup(linkListMemo, linkLookupBarriers, input.userId, environments, nowMs);
      }
      return environments;
    }),

    getForUser: Effect.fn("relay.environment_links.get_for_user")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
      });
      const memoKey = linkRecordMemoKey(input);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      // A caller that decides a write from this record must never be answered from the memo, and
      // must not warm it either: `unlinkEnvironmentRecord` picks the credential to revoke out of
      // `environmentPublicKey`, so one stale record revokes the wrong key and leaves the current
      // one live.
      const remembered =
        input.bypassMemo === true ? null : readTtlMemo(linkRecordMemo, memoKey, nowMs);
      yield* Effect.annotateCurrentSpan({
        "relay.link_lookup.memo_hit": remembered !== null,
        "relay.link_lookup.bypass_memo": input.bypassMemo === true,
      });
      if (remembered !== null) {
        return remembered;
      }
      const link = yield* db
        .select({
          environmentId: relayEnvironmentLinks.environmentId,
          environmentLabel: relayEnvironmentLinks.environmentLabel,
          environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
          endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
          endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
          endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
          createdAt: relayEnvironmentLinks.createdAt,
        })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .limit(1)
        .pipe(
          Effect.map((rows) => {
            const row = rows[0];
            return row
              ? {
                  environmentId: row.environmentId as RelayClientEnvironmentRecord["environmentId"],
                  label:
                    row.environmentLabel.trim().length > 0
                      ? row.environmentLabel
                      : row.environmentId,
                  endpoint: {
                    httpBaseUrl: row.endpointHttpBaseUrl,
                    wsBaseUrl: row.endpointWsBaseUrl,
                    providerKind:
                      row.endpointProviderKind as RelayClientEnvironmentRecord["endpoint"]["providerKind"],
                  },
                  environmentPublicKey: row.environmentPublicKey,
                  linkedAt: row.createdAt,
                }
              : null;
          }),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkLookupPersistenceError({
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      if (link !== null && input.bypassMemo !== true) {
        rememberLinkLookup(linkRecordMemo, linkLookupBarriers, memoKey, link, nowMs);
      }
      return link;
    }),

    revokeForUser: Effect.fn("relay.environment_links.revoke_for_user")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
      });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayEnvironmentLinks)
        .set({
          revokedAt,
          updatedAt: revokedAt,
        })
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .returning({ environmentId: relayEnvironmentLinks.environmentId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkRevokePersistenceError({
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      forgetLinkLookups(input, DateTime.toEpochMillis(yield* DateTime.now));
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(EnvironmentLinks, make);
