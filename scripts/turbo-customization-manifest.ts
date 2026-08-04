#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This verifier runs before workspace dependencies are installed.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type TurboCustomizationStatus = "implemented" | "planned" | "policy";

export interface TurboCustomizationCheck {
  readonly path: string;
  readonly markers: ReadonlyArray<string>;
}

export interface TurboCustomizationSeam {
  readonly id: string;
  readonly status: TurboCustomizationStatus;
  readonly summary: string;
  readonly checks: ReadonlyArray<TurboCustomizationCheck>;
}

export interface TurboCustomizationManifest {
  readonly schemaVersion: 1;
  readonly product: "T3 Turbo";
  readonly seams: ReadonlyArray<TurboCustomizationSeam>;
}

export interface TurboCustomizationFailure {
  readonly seamId: string;
  readonly path: string;
  readonly reason: string;
}

export interface TurboCustomizationVerification {
  readonly manifest: TurboCustomizationManifest;
  readonly checkCount: number;
  readonly failures: ReadonlyArray<TurboCustomizationFailure>;
}

const MANIFEST_PATH = ".t3-turbo/customizations.json";
const STATUS_VALUES = new Set<TurboCustomizationStatus>(["implemented", "planned", "policy"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePortableRelativePath(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${context} must be a portable repository-relative path: ${value}`);
  }
  return value;
}

function decodeCheck(value: unknown, context: string): TurboCustomizationCheck {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  const path = decodePortableRelativePath(value.path, `${context}.path`);
  if (!Array.isArray(value.markers)) throw new Error(`${context}.markers must be an array.`);
  const markers = value.markers.map((marker, index) => {
    if (typeof marker !== "string" || marker.length === 0) {
      throw new Error(`${context}.markers[${index}] must be a non-empty string.`);
    }
    return marker;
  });
  if (new Set(markers).size !== markers.length) {
    throw new Error(`${context}.markers must not contain duplicates.`);
  }
  return { path, markers };
}

export function decodeTurboCustomizationManifest(value: unknown): TurboCustomizationManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== "T3 Turbo") {
    throw new Error(
      'Turbo customization manifest must use schemaVersion 1 and product "T3 Turbo".',
    );
  }
  if (!Array.isArray(value.seams) || value.seams.length === 0) {
    throw new Error("Turbo customization manifest must contain at least one seam.");
  }

  const ids = new Set<string>();
  const seams = value.seams.map((seam, seamIndex): TurboCustomizationSeam => {
    const context = `seams[${seamIndex}]`;
    if (!isRecord(seam)) throw new Error(`${context} must be an object.`);
    if (typeof seam.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(seam.id)) {
      throw new Error(`${context}.id must be a lowercase kebab-case identifier.`);
    }
    if (ids.has(seam.id)) throw new Error(`Duplicate Turbo customization seam id: ${seam.id}`);
    ids.add(seam.id);
    if (
      typeof seam.status !== "string" ||
      !STATUS_VALUES.has(seam.status as TurboCustomizationStatus)
    ) {
      throw new Error(`${context}.status must be implemented, planned, or policy.`);
    }
    if (typeof seam.summary !== "string" || seam.summary.trim().length === 0) {
      throw new Error(`${context}.summary must be a non-empty string.`);
    }
    if (!Array.isArray(seam.checks) || seam.checks.length === 0) {
      throw new Error(`${context}.checks must contain at least one check.`);
    }
    return {
      id: seam.id,
      status: seam.status as TurboCustomizationStatus,
      summary: seam.summary,
      checks: seam.checks.map((check, checkIndex) =>
        decodeCheck(check, `${context}.checks[${checkIndex}]`),
      ),
    };
  });

  return { schemaVersion: 1, product: "T3 Turbo", seams };
}

function resolveRepositoryPath(root: string, relativePath: string): string {
  const resolvedRoot = NodePath.resolve(root);
  const resolvedPath = NodePath.resolve(resolvedRoot, relativePath);
  const relative = NodePath.relative(resolvedRoot, resolvedPath);
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return resolvedPath;
}

export function verifyTurboCustomizationManifest(input: {
  readonly root: string;
  readonly manifestPath?: string;
}): TurboCustomizationVerification {
  const root = NodePath.resolve(input.root);
  const manifestPath = resolveRepositoryPath(root, input.manifestPath ?? MANIFEST_PATH);
  const manifest = decodeTurboCustomizationManifest(
    JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as unknown,
  );
  const failures: TurboCustomizationFailure[] = [];
  let checkCount = 0;

  for (const seam of manifest.seams) {
    for (const check of seam.checks) {
      checkCount += 1;
      const targetPath = resolveRepositoryPath(root, check.path);
      let stat: NodeFS.Stats;
      try {
        stat = NodeFS.statSync(targetPath);
      } catch (cause) {
        if (isRecord(cause) && cause.code === "ENOENT") {
          failures.push({ seamId: seam.id, path: check.path, reason: "file is missing" });
          continue;
        }
        throw cause;
      }
      if (!stat.isFile()) {
        failures.push({ seamId: seam.id, path: check.path, reason: "path is not a file" });
        continue;
      }
      if (check.markers.length === 0) continue;
      const contents = NodeFS.readFileSync(targetPath, "utf8");
      for (const marker of check.markers) {
        if (!contents.includes(marker)) {
          failures.push({
            seamId: seam.id,
            path: check.path,
            reason: `missing content marker ${JSON.stringify(marker)}`,
          });
        }
      }
    }
  }

  return { manifest, checkCount, failures };
}

function parseCliArguments(args: ReadonlyArray<string>): { root: string; manifestPath?: string } {
  if (args[0] !== "verify") {
    throw new Error(
      "Usage: turbo-customization-manifest.ts verify [--root <path>] [--manifest <path>]",
    );
  }
  let root = process.cwd();
  let manifestPath: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if ((argument === "--root" || argument === "--manifest") && value) {
      if (argument === "--root") root = value;
      else manifestPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return { root, ...(manifestPath ? { manifestPath } : {}) };
}

function runCli(): void {
  try {
    const result = verifyTurboCustomizationManifest(parseCliArguments(process.argv.slice(2)));
    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        process.stderr.write(`[${failure.seamId}] ${failure.path}: ${failure.reason}\n`);
      }
      process.stderr.write(
        `T3 Turbo customization verification failed: ${result.failures.length} problem(s) across ${result.manifest.seams.length} seams.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Verified ${result.manifest.seams.length} T3 Turbo customization seams (${result.checkCount} file checks).\n`,
    );
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodePath.resolve(import.meta.filename);
if (isMain) runCli();
