#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This source-sync bootstrap runs before workspace dependencies are installed.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export interface TurboUpstreamState {
  readonly repository: string;
  readonly tag: string;
  readonly sha: string;
}

export interface GitHubRelease {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly published_at?: unknown;
}

export interface TurboNightlyRelease {
  readonly tag: string;
  readonly version: string;
  readonly publishedAt: string;
}

const NIGHTLY_TAG_PATTERN = /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)$/u;

export function compareTurboNightlyTags(left: string, right: string): number {
  if (!NIGHTLY_TAG_PATTERN.test(left) || !NIGHTLY_TAG_PATTERN.test(right)) {
    throw new Error("Cannot compare invalid Turbo nightly tags.");
  }
  const leftParts = left.match(/\d+/gu)?.map(Number) ?? [];
  const rightParts = right.match(/\d+/gu)?.map(Number) ?? [];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeTurboUpstreamState(value: unknown): TurboUpstreamState {
  if (
    !isRecord(value) ||
    typeof value.repository !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.sha !== "string"
  ) {
    throw new Error("Turbo upstream state must contain repository, tag, and sha strings.");
  }
  const state = {
    repository: value.repository,
    tag: value.tag,
    sha: value.sha,
  };
  if (!NIGHTLY_TAG_PATTERN.test(state.tag)) {
    throw new Error(`Turbo upstream state has an invalid nightly tag: ${state.tag}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(state.sha)) {
    throw new Error(`Turbo upstream state has an invalid commit sha: ${state.sha}`);
  }
  return state;
}

export function selectLatestNightlyRelease(value: unknown): TurboNightlyRelease {
  if (!Array.isArray(value)) {
    throw new Error("GitHub releases payload must be an array.");
  }

  const releases = value.flatMap((candidate): ReadonlyArray<TurboNightlyRelease> => {
    if (!isRecord(candidate) || candidate.draft === true || candidate.prerelease !== true)
      return [];
    if (typeof candidate.tag_name !== "string" || typeof candidate.published_at !== "string") {
      return [];
    }
    const match = NIGHTLY_TAG_PATTERN.exec(candidate.tag_name);
    if (!match?.[1] || Number.isNaN(Date.parse(candidate.published_at))) return [];
    return [{ tag: candidate.tag_name, version: match[1], publishedAt: candidate.published_at }];
  });

  const latest = releases.toSorted((left, right) => {
    const versionOrder = compareTurboNightlyTags(right.tag, left.tag);
    return versionOrder !== 0
      ? versionOrder
      : Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  })[0];
  if (!latest) throw new Error("No published official nightly release was found.");
  return latest;
}

export function findPathCollisions(
  upstreamPaths: ReadonlyArray<string>,
  customizationPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const custom = new Set(customizationPaths.map((path) => path.trim()).filter(Boolean));
  return [
    ...new Set(upstreamPaths.map((path) => path.trim()).filter((path) => custom.has(path))),
  ].toSorted();
}

export function renderTurboCollisionReport(input: {
  readonly oldTag: string;
  readonly oldSha: string;
  readonly newTag: string;
  readonly newSha: string;
  readonly overlappingPaths: ReadonlyArray<string>;
  readonly unmergedPaths: ReadonlyArray<string>;
  readonly rebaseError: string;
}): string {
  const section = (title: string, paths: ReadonlyArray<string>) =>
    paths.length === 0
      ? `### ${title}\n\nNone.\n`
      : `### ${title}\n\n${paths.map((path) => `- \`${path}\``).join("\n")}\n`;
  const error = input.rebaseError.trim() || "Git did not provide stderr.";
  return [
    "# T3-Turbo nightly rebase needs review",
    "",
    `- Previous official nightly: \`${input.oldTag}\` (\`${input.oldSha}\`)`,
    `- Candidate official nightly: \`${input.newTag}\` (\`${input.newSha}\`)`,
    "",
    "The automation stopped without resolving or publishing anything.",
    "",
    section("Files changed by both upstream and Turbo", input.overlappingPaths),
    section("Unmerged paths reported by Git", input.unmergedPaths),
    "### Rebase error",
    "",
    "```text",
    error,
    "```",
    "",
  ].join("\n");
}

function readJson(path: string): unknown {
  return JSON.parse(NodeFS.readFileSync(path, "utf8"));
}

function readPathList(path: string | undefined): ReadonlyArray<string> {
  if (!path || !NodeFS.existsSync(path)) return [];
  return NodeFS.readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function appendGitHubOutput(values: Readonly<Record<string, string>>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required when --github-output is set.");
  NodeFS.appendFileSync(
    outputPath,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

function runResolve(values: Record<string, string | boolean | undefined>): void {
  const releasesPath = values.releases;
  const statePath = values.state;
  if (typeof releasesPath !== "string" || typeof statePath !== "string") {
    throw new Error("resolve requires --releases and --state.");
  }
  const state = decodeTurboUpstreamState(readJson(statePath));
  const release = selectLatestNightlyRelease(readJson(releasesPath));
  const output = {
    has_update: String(compareTurboNightlyTags(release.tag, state.tag) > 0),
    tag: release.tag,
    version: release.version,
    old_tag: state.tag,
    old_sha: state.sha,
    repository: state.repository,
  };
  if (values["github-output"] === true) appendGitHubOutput(output);
  else process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function runReport(values: Record<string, string | boolean | undefined>): void {
  const outputPath = values.output;
  if (typeof outputPath !== "string") throw new Error("report requires --output.");
  const required = ["old-tag", "old-sha", "new-tag", "new-sha"] as const;
  for (const name of required) {
    if (typeof values[name] !== "string") throw new Error(`report requires --${name}.`);
  }
  const upstreamPaths = readPathList(
    typeof values["upstream-paths"] === "string" ? values["upstream-paths"] : undefined,
  );
  const customizationPaths = readPathList(
    typeof values["customization-paths"] === "string" ? values["customization-paths"] : undefined,
  );
  const rebaseErrorPath =
    typeof values["rebase-error"] === "string" ? values["rebase-error"] : undefined;
  const report = renderTurboCollisionReport({
    oldTag: values["old-tag"] as string,
    oldSha: values["old-sha"] as string,
    newTag: values["new-tag"] as string,
    newSha: values["new-sha"] as string,
    overlappingPaths: findPathCollisions(upstreamPaths, customizationPaths),
    unmergedPaths: readPathList(
      typeof values["unmerged-paths"] === "string" ? values["unmerged-paths"] : undefined,
    ),
    rebaseError:
      rebaseErrorPath && NodeFS.existsSync(rebaseErrorPath)
        ? NodeFS.readFileSync(rebaseErrorPath, "utf8")
        : "",
  });
  NodeFS.mkdirSync(NodePath.dirname(NodePath.resolve(outputPath)), { recursive: true });
  NodeFS.writeFileSync(outputPath, report);
}

const isMain =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodePath.resolve(import.meta.filename);
if (isMain) {
  const command = process.argv[2];
  const { values } = NodeUtil.parseArgs({
    args: process.argv.slice(3),
    options: {
      releases: { type: "string" },
      state: { type: "string" },
      "github-output": { type: "boolean" },
      output: { type: "string" },
      "old-tag": { type: "string" },
      "old-sha": { type: "string" },
      "new-tag": { type: "string" },
      "new-sha": { type: "string" },
      "upstream-paths": { type: "string" },
      "customization-paths": { type: "string" },
      "unmerged-paths": { type: "string" },
      "rebase-error": { type: "string" },
    },
    strict: true,
  });
  if (command === "resolve") runResolve(values);
  else if (command === "report") runReport(values);
  else throw new Error("Expected command 'resolve' or 'report'.");
}
