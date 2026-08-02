import { DesktopOfficialT3EnvironmentSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { discoverOfficialT3Environment } from "../../app/OfficialT3EnvironmentDiscovery.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const discoverOfficialT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_OFFICIAL_T3_ENVIRONMENT_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopOfficialT3EnvironmentSchema),
  handler: Effect.fn("desktop.ipc.officialT3.discover")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const path = yield* Path.Path;
    const officialStateDir = path.join(environment.homeDirectory, ".t3", "userdata");

    // A custom Turbo home may point at the official T3 state directory. Never
    // advertise the current backend as an external environment in that case.
    if (path.resolve(environment.stateDir) === path.resolve(officialStateDir)) {
      return null;
    }

    return yield* discoverOfficialT3Environment(path.join(officialStateDir, "server-runtime.json"));
  }),
});
