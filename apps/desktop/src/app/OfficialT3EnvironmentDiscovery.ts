import type { DesktopOfficialT3ImportAvailability } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const quoteCliArgument = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;

const importCommand = (
  mode: "plan" | "run",
  sourceBaseDir: string,
  targetBaseDir: string,
): string =>
  [
    "t3 import official",
    mode,
    "--source-base-dir",
    quoteCliArgument(sourceBaseDir),
    "--target-base-dir",
    quoteCliArgument(targetBaseDir),
  ].join(" ");

/**
 * Discover importable official T3 data without probing or attaching to an
 * official server. Both databases stay closed; the importer owns snapshotting
 * and validation after the user starts an import.
 */
export const discoverOfficialT3ImportAvailability = Effect.fn("desktop.officialT3Import.discover")(
  function* (input: {
    readonly sourceBaseDir: string;
    readonly targetBaseDir: string;
  }): Effect.fn.Return<
    DesktopOfficialT3ImportAvailability | null,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourceBaseDir = path.resolve(input.sourceBaseDir);
    const targetBaseDir = path.resolve(input.targetBaseDir);
    if (sourceBaseDir.toLowerCase() === targetBaseDir.toLowerCase()) return null;

    const [sourceExists, targetExists] = yield* Effect.all([
      fs.exists(path.join(sourceBaseDir, "userdata", "state.sqlite")),
      fs.exists(path.join(targetBaseDir, "userdata", "state.sqlite")),
    ]).pipe(Effect.orElseSucceed(() => [false, false] as const));
    if (!sourceExists || !targetExists) return null;

    return {
      sourceBaseDir,
      targetBaseDir,
      runCommand: importCommand("run", sourceBaseDir, targetBaseDir),
      planCommand: importCommand("plan", sourceBaseDir, targetBaseDir),
    };
  },
);
