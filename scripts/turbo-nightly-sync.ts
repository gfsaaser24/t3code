#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This source-sync bootstrap runs before workspace dependencies are installed.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export interface TurboUpstreamState {
  readonly repository: string;
  readonly branch: string;
  readonly mainSha: string;
  readonly nightlyTag: string;
  readonly nightlySha: string;
  readonly version: string;
  readonly cutoffDate?: string;
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
const TURBO_NIGHTLY_TAG_PATTERN =
  /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+(?:\.turbo\.\d+(?:\.\d+)?)?)$/u;
const TURBO_NIGHTLY_VERSION_PATTERN =
  /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+(?:\.turbo\.\d+(?:\.\d+)?)?$/u;
const CUTOFF_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function compareTurboNightlyTags(left: string, right: string): number {
  if (!TURBO_NIGHTLY_TAG_PATTERN.test(left) || !TURBO_NIGHTLY_TAG_PATTERN.test(right)) {
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
    typeof value.branch !== "string" ||
    typeof value.mainSha !== "string" ||
    typeof value.nightlyTag !== "string" ||
    typeof value.nightlySha !== "string" ||
    typeof value.version !== "string"
  ) {
    throw new Error(
      "Turbo upstream state must contain repository, branch, mainSha, nightlyTag, nightlySha, and version strings.",
    );
  }
  const cutoffDate = value.cutoffDate;
  if (
    cutoffDate !== undefined &&
    (typeof cutoffDate !== "string" || !CUTOFF_DATE_PATTERN.test(cutoffDate))
  ) {
    throw new Error("Turbo upstream cutoffDate must use YYYY-MM-DD when present.");
  }
  const state = {
    repository: value.repository,
    branch: value.branch,
    mainSha: value.mainSha,
    nightlyTag: value.nightlyTag,
    nightlySha: value.nightlySha,
    version: value.version,
    ...(typeof cutoffDate === "string" ? { cutoffDate } : {}),
  };
  if (!state.repository.trim() || !state.branch.trim()) {
    throw new Error("Turbo upstream repository and branch cannot be empty.");
  }
  if (!NIGHTLY_TAG_PATTERN.test(state.nightlyTag)) {
    throw new Error(`Turbo upstream state has an invalid nightly tag: ${state.nightlyTag}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(state.mainSha) || !/^[0-9a-f]{40}$/u.test(state.nightlySha)) {
    throw new Error("Turbo upstream state has an invalid commit sha.");
  }
  if (!TURBO_NIGHTLY_VERSION_PATTERN.test(state.version)) {
    throw new Error(`Turbo upstream state has an invalid published version: ${state.version}`);
  }
  const nightlyVersion = state.nightlyTag.slice(1);
  const snapshotSuffix = state.version.slice(nightlyVersion.length);
  if (
    state.version !== nightlyVersion &&
    (!state.version.startsWith(nightlyVersion) ||
      !/^\.turbo\.[1-9]\d*(?:\.[1-9]\d*)?$/u.test(snapshotSuffix))
  ) {
    throw new Error("Turbo published version must derive from its recorded Nightly tag.");
  }
  return state;
}

export function createTurboMainSnapshotVersion(input: {
  readonly releaseVersion: string;
  readonly mainDistance: number;
}): string {
  if (!NIGHTLY_TAG_PATTERN.test(`v${input.releaseVersion}`)) {
    throw new Error(`Invalid official Nightly version: ${input.releaseVersion}`);
  }
  if (!Number.isSafeInteger(input.mainDistance) || input.mainDistance < 0) {
    throw new Error("Upstream main distance must be a non-negative integer.");
  }
  return input.mainDistance === 0
    ? input.releaseVersion
    : `${input.releaseVersion}.turbo.${input.mainDistance}`;
}

export function createTurboDailyVersion(input: {
  readonly releaseVersion: string;
  readonly cutoffDate: string;
  readonly releaseSequence: number;
}): string {
  if (!NIGHTLY_TAG_PATTERN.test(`v${input.releaseVersion}`)) {
    throw new Error(`Invalid official Nightly version: ${input.releaseVersion}`);
  }
  const cutoffMatch = CUTOFF_DATE_PATTERN.exec(input.cutoffDate);
  if (!cutoffMatch) throw new Error("Turbo cutoff date must use YYYY-MM-DD.");
  const cutoff = `${cutoffMatch[1]}${cutoffMatch[2]}${cutoffMatch[3]}`;
  if (!Number.isSafeInteger(input.releaseSequence) || input.releaseSequence <= 0) {
    throw new Error("Turbo release sequence must be a positive integer.");
  }
  return `${input.releaseVersion}.turbo.${cutoff}.${input.releaseSequence}`;
}

export function resolveTurboInboundUpdate(input: {
  readonly state: TurboUpstreamState;
  readonly release: TurboNightlyRelease;
  readonly mainSha: string;
  readonly nightlySha: string;
  readonly mainDistance: number;
  readonly cutoffDate?: string;
  readonly releaseSequence?: number;
}) {
  if (!/^[0-9a-f]{40}$/u.test(input.mainSha) || !/^[0-9a-f]{40}$/u.test(input.nightlySha)) {
    throw new Error("Official inbound metadata has an invalid commit sha.");
  }
  const releaseOrder = compareTurboNightlyTags(input.release.tag, input.state.nightlyTag);
  if (releaseOrder < 0) {
    throw new Error("Refusing to move the recorded official Nightly release backward.");
  }
  if (releaseOrder === 0 && input.nightlySha !== input.state.nightlySha) {
    throw new Error("The recorded official Nightly tag now points at a different commit.");
  }

  if ((input.cutoffDate === undefined) !== (input.releaseSequence === undefined)) {
    throw new Error("Turbo daily releases require both cutoffDate and releaseSequence.");
  }
  const version =
    input.cutoffDate === undefined || input.releaseSequence === undefined
      ? createTurboMainSnapshotVersion({
          releaseVersion: input.release.version,
          mainDistance: input.mainDistance,
        })
      : createTurboDailyVersion({
          releaseVersion: input.release.version,
          cutoffDate: input.cutoffDate,
          releaseSequence: input.releaseSequence,
        });
  const hasUpdate =
    releaseOrder > 0 || input.mainSha !== input.state.mainSha || version !== input.state.version;
  const versionOrder = compareTurboNightlyTags(`v${version}`, `v${input.state.version}`);
  if (hasUpdate && versionOrder <= 0) {
    throw new Error("Refusing to publish an upstream main snapshot without advancing the version.");
  }
  if (!hasUpdate && versionOrder !== 0) {
    throw new Error("Recorded Turbo version does not match the current upstream snapshot.");
  }
  return {
    has_update: String(hasUpdate),
    tag: `v${version}`,
    version,
    official_tag: input.release.tag,
    nightly_sha: input.nightlySha,
    source_sha: input.mainSha,
    old_tag: input.state.nightlyTag,
    old_nightly_sha: input.state.nightlySha,
    old_main_sha: input.state.mainSha,
    old_version: input.state.version,
    repository: input.state.repository,
    branch: input.state.branch,
    ...(input.cutoffDate === undefined
      ? {}
      : {
          cutoff_date: input.cutoffDate,
          cutoff_label: `${input.cutoffDate.slice(5, 7)}-${input.cutoffDate.slice(8, 10)}-${input.cutoffDate.slice(2, 4)}`,
        }),
  };
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

function decodeMainSha(value: unknown): string {
  if (!isRecord(value) || typeof value.sha !== "string" || !/^[0-9a-f]{40}$/u.test(value.sha)) {
    throw new Error("Official main metadata must contain a valid commit sha.");
  }
  return value.sha;
}

function decodeMainComparison(value: unknown): {
  readonly nightlySha: string;
  readonly distance: number;
} {
  if (
    !isRecord(value) ||
    (value.status !== "ahead" && value.status !== "identical") ||
    !Number.isSafeInteger(value.ahead_by) ||
    (value.ahead_by as number) < 0 ||
    !isRecord(value.base_commit) ||
    typeof value.base_commit.sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.base_commit.sha)
  ) {
    throw new Error("Official Nightly must be identical to or an ancestor of upstream main.");
  }
  return { nightlySha: value.base_commit.sha, distance: value.ahead_by as number };
}

function runLatest(values: Record<string, string | boolean | undefined>): void {
  const releasesPath = values.releases;
  if (typeof releasesPath !== "string") throw new Error("latest requires --releases.");
  process.stdout.write(
    `${JSON.stringify(selectLatestNightlyRelease(readJson(releasesPath)), null, 2)}\n`,
  );
}

function runResolve(values: Record<string, string | boolean | undefined>): void {
  const releasesPath = values.releases;
  const statePath = values.state;
  const mainPath = values.main;
  const comparePath = values.compare;
  if (
    typeof releasesPath !== "string" ||
    typeof statePath !== "string" ||
    typeof mainPath !== "string" ||
    typeof comparePath !== "string"
  ) {
    throw new Error("resolve requires --releases, --state, --main, and --compare.");
  }
  const state = decodeTurboUpstreamState(readJson(statePath));
  const release = selectLatestNightlyRelease(readJson(releasesPath));
  const mainSha = decodeMainSha(readJson(mainPath));
  const comparison = decodeMainComparison(readJson(comparePath));
  const cutoffDate = values["cutoff-date"];
  const releaseSequenceValue = values["release-sequence"];
  const releaseSequence =
    typeof releaseSequenceValue === "string" ? Number(releaseSequenceValue) : undefined;
  const output = resolveTurboInboundUpdate({
    state,
    release,
    mainSha,
    nightlySha: comparison.nightlySha,
    mainDistance: comparison.distance,
    ...(typeof cutoffDate === "string" ? { cutoffDate } : {}),
    ...(releaseSequence === undefined ? {} : { releaseSequence }),
  });
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
      main: { type: "string" },
      compare: { type: "string" },
      "cutoff-date": { type: "string" },
      "release-sequence": { type: "string" },
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
  if (command === "latest") runLatest(values);
  else if (command === "resolve") runResolve(values);
  else if (command === "report") runReport(values);
  else throw new Error("Expected command 'latest', 'resolve', or 'report'.");
}
