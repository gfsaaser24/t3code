import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runServer } from "../server.ts";
import {
  recoverOfficialImportTransactionsWithinLock,
  withOfficialImportLock,
} from "../turbo/officialImport/storage.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    // Hold the import lock for crash recovery only — never for the server's
    // whole lifetime. The lock is a directory on disk with no OS-backed
    // reclamation, so a lifetime-scoped hold leaks it on every hard kill (which
    // is how the supervisor stops the backend) and blocks the next launch.
    // Importer runs are kept out by `server-runtime.json` instead: see
    // `assertNoLiveImportServer`, the purpose-built guard for "a live backend
    // owns this database".
    yield* withOfficialImportLock(
      config.dbPath,
      recoverOfficialImportTransactionsWithinLock(config.dbPath),
    );
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Turbo server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Turbo server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
