import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

const optionalConfig = <A>(config: Config.Config<A>) =>
  config.pipe(
    Config.map(Option.some),
    Config.orElse(() => Config.succeed(Option.none<A>())),
  );

export const ApnsCredentialsConfig = Config.all({
  environment: optionalConfig(Config.schema(ApnsEnvironment, "APNS_ENVIRONMENT")),
  teamId: optionalConfig(Config.nonEmptyString("APNS_TEAM_ID")),
  keyId: optionalConfig(Config.nonEmptyString("APNS_KEY_ID")),
  privateKey: optionalConfig(
    Config.nonEmptyString("APNS_PRIVATE_KEY").pipe(Config.map(Redacted.make)),
  ),
  bundleId: optionalConfig(Config.nonEmptyString("APNS_BUNDLE_ID")),
}).pipe(Config.map((credentials) => Option.getOrNull(Option.all(credentials))));

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials | null;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
