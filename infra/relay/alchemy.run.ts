// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Planetscale from "alchemy/Planetscale";

import * as RelayDb from "./src/db.ts";
import { AxiomConfiguration, RelayObservability } from "./src/observability.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import ApiLive, { Api } from "./src/worker.ts";

const emptyProviderCollection = {
  kind: "ProviderCollection" as const,
  get: () => undefined,
  providers: {},
};

const axiomProviders = Layer.unwrap(
  AxiomConfiguration.pipe(
    Effect.map(
      Option.match({
        onNone: () => Layer.succeed(Axiom.Providers, emptyProviderCollection),
        onSome: () => Axiom.providers(),
      }),
    ),
  ),
).pipe(Layer.orDie);

const planetscaleProviders = Layer.unwrap(
  RelayDb.ExternalDatabaseConfiguration.pipe(
    Effect.map(
      Option.match({
        onNone: () => Planetscale.providers(),
        onSome: () => Layer.succeed(Planetscale.Providers, emptyProviderCollection),
      }),
    ),
  ),
).pipe(Layer.orDie);

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(
      axiomProviders,
      Cloudflare.providers(),
      Drizzle.providers(),
      planetscaleProviders,
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const database = yield* RelayDb.RelayDatabase;
    const hyperdrive = database.hyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const api = yield* Api;

    return {
      databaseName: database.databaseName,
      databaseBranchName: database.databaseBranchName,
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      ...(observability.enabled
        ? {
            mobileTracingUrl: observability.traces.otelTracesEndpoint,
            mobileTracingDataset: observability.traces.name,
            mobileTracingToken: observability.mobileIngestToken.token,
            clientTracingUrl: observability.traces.otelTracesEndpoint,
            clientTracingDataset: observability.traces.name,
            clientTracingToken: observability.clientIngestToken.token,
          }
        : {}),
    };
  }).pipe(Effect.provide(ApiLive)),
);
