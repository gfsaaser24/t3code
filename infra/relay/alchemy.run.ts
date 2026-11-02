// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Planetscale from "@alchemy.run/planetscale";

import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import {
  AxiomConfiguration,
  MobileSourceMapsUploadCredentials,
  RelayObservability,
} from "./src/observability.ts";
import { isPreviewStage } from "./src/previewStages.ts";
import { PreviewTunnelSweep, PreviewTunnelSweepProvider } from "./src/previewTunnelSweep.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

// Self-hosting: a provider whose credentials are not configured is replaced by an
// empty collection, so a relay without Axiom (or on an external database instead
// of PlanetScale) never asks for those credentials.
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
      PreviewTunnelSweepProvider(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const database = yield* RelayDb.RelayDatabase;
    const hyperdrive = database.hyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    // Self-hosting: the source maps bucket is created only with Axiom, so its
    // upload token is too.
    const mobileSourceMapsUploadCredentials = observability.enabled
      ? yield* MobileSourceMapsUploadCredentials
      : undefined;
    const api = yield* RelayWorker.Api;
    if (isPreviewStage(stage)) {
      const { managedEndpointZoneName } = yield* RelayDeploymentConfig;
      yield* PreviewTunnelSweep("PreviewTunnelSweep", {
        stage,
        tunnelZoneName: managedEndpointZoneName,
        workerName: api.workerName,
      });
    }
    // Without Axiom there is no dataset and no ingest tokens: the client still
    // gets its relay URL and the tracing assignments are published empty.
    const clientTracingConfig = observability.enabled
      ? {
          mobileTracingUrl: observability.traces.otelTracesEndpoint,
          mobileTracingDataset: observability.traces.name,
          mobileTracingToken: observability.mobileIngestToken.token,
          clientTracingUrl: observability.traces.otelTracesEndpoint,
          clientTracingDataset: observability.traces.name,
          clientTracingToken: observability.clientIngestToken.token,
          tokenDigest: Output.map(
            Output.all(
              observability.mobileIngestToken.token,
              observability.clientIngestToken.token,
            ),
            tokenDigest,
          ),
        }
      : {
          mobileTracingUrl: "",
          mobileTracingDataset: "",
          mobileTracingToken: Redacted.make(""),
          clientTracingUrl: "",
          clientTracingDataset: "",
          clientTracingToken: Redacted.make(""),
          tokenDigest: "",
        };
    yield* PublishClientConfig({ url: api.url, ...clientTracingConfig });

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
            mobileLogsDataset: observability.mobileLogs.name,
            mobileMetricsDataset: observability.mobileMetrics.name,
            mobileSourceMapsBucket: observability.mobileSourceMaps.bucketName,
            // The MOBILE_SOURCEMAPS_R2 secret for GitHub Actions and EAS Build.
            mobileSourceMapsUploadCredentials,
          }
        : {}),
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
