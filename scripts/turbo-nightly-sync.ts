#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This source-sync bootstrap runs before workspace dependencies are installed.

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
  readonly cutoffInstant?: string;
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

// Upstream's official Nightly tags. This describes `pingdotgg/t3code`, never our own releases.
const NIGHTLY_TAG_PATTERN = /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)$/u;
// T3 Turbo publishes on its own version line: a plain MAJOR.MINOR.PATCH counter that gains one
// patch per published build and carries no upstream version component.
const TURBO_NIGHTLY_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/u;
const TURBO_NIGHTLY_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
// The version recorded before the fork moved to its own line was derived from upstream's Nightly
// tag. It is accepted on read until the first run on the new scheme rewrites it, and it is treated
// as lower than any plain semver so base selection falls back to the fork's manifest version.
const LEGACY_TURBO_VERSION_PATTERN =
  /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+(?:\.turbo\.\d+(?:\.\d+)?)?$/u;
const CUTOFF_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BRANCH_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const EASTERN_TIME_ZONE = "America/New_York";
const EASTERN_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface ZonedDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function decodeInstant(value: string, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${context} must be a canonical ISO-8601 UTC instant.`);
  }
  return timestamp;
}

function getEasternDateTimeParts(timestamp: number): ZonedDateTimeParts {
  const values = Object.fromEntries(
    EASTERN_DATE_TIME_FORMATTER.formatToParts(timestamp).flatMap((part) =>
      part.type === "literal" ? [] : [[part.type, Number(part.value)]],
    ),
  );
  if (
    !Number.isSafeInteger(values.year) ||
    !Number.isSafeInteger(values.month) ||
    !Number.isSafeInteger(values.day) ||
    !Number.isSafeInteger(values.hour) ||
    !Number.isSafeInteger(values.minute) ||
    !Number.isSafeInteger(values.second)
  ) {
    throw new Error("Unable to resolve the Eastern-time nightly cutoff.");
  }
  return values as unknown as ZonedDateTimeParts;
}

function easternLocalTimeToInstant(parts: ZonedDateTimeParts): number {
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desiredAsUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = getEasternDateTimeParts(candidate);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    candidate += desiredAsUtc - actualAsUtc;
  }
  const resolved = getEasternDateTimeParts(candidate);
  if (
    Object.entries(parts).some(
      ([key, value]) => resolved[key as keyof ZonedDateTimeParts] !== value,
    )
  ) {
    throw new Error("Unable to map the Eastern-time nightly cutoff to UTC.");
  }
  return candidate;
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatCutoffLabel(cutoffDate: string): string {
  return `${cutoffDate.slice(5, 7)}-${cutoffDate.slice(8, 10)}-${cutoffDate.slice(2, 4)}`;
}

function easternCalendarDate(timestamp: number): string {
  const parts = getEasternDateTimeParts(timestamp);
  return formatCalendarDate(parts.year, parts.month, parts.day);
}

export function resolveTurboEasternCutoff(now: string | Date = new Date()): {
  readonly cutoffDate: string;
  readonly cutoffLabel: string;
  readonly cutoffInstant: string;
} {
  const nowTimestamp =
    typeof now === "string" ? decodeInstant(now, "Turbo cutoff reference time") : now.getTime();
  if (!Number.isFinite(nowTimestamp)) throw new Error("Turbo cutoff reference time is invalid.");

  const easternNow = getEasternDateTimeParts(nowTimestamp);
  const localCalendarDate = Date.UTC(easternNow.year, easternNow.month - 1, easternNow.day);
  const cutoffCalendarDate = new Date(
    easternNow.hour >= 23 ? localCalendarDate : localCalendarDate - 24 * 60 * 60 * 1_000,
  );
  const year = cutoffCalendarDate.getUTCFullYear();
  const month = cutoffCalendarDate.getUTCMonth() + 1;
  const day = cutoffCalendarDate.getUTCDate();
  const cutoffInstant = new Date(
    easternLocalTimeToInstant({ year, month, day, hour: 23, minute: 0, second: 0 }),
  ).toISOString();
  const cutoffDate = formatCalendarDate(year, month, day);
  return { cutoffDate, cutoffLabel: formatCutoffLabel(cutoffDate), cutoffInstant };
}

/**
 * Resolves the cutoff from an explicit instant supplied by a manual run, so an operator can ingest
 * before the scheduled 11 PM Eastern boundary. The cutoff date is the Eastern calendar date the
 * instant falls on. Scheduled runs never take this path.
 */
export function resolveTurboCutoffOverride(
  cutoffInstant: string,
  now: string | Date = new Date(),
): {
  readonly cutoffDate: string;
  readonly cutoffLabel: string;
  readonly cutoffInstant: string;
} {
  const timestamp = Date.parse(cutoffInstant);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Turbo cutoff override must be an ISO-8601 instant.");
  }
  const nowTimestamp =
    typeof now === "string" ? decodeInstant(now, "Turbo cutoff reference time") : now.getTime();
  if (!Number.isFinite(nowTimestamp)) throw new Error("Turbo cutoff reference time is invalid.");
  if (timestamp > nowTimestamp) {
    throw new Error("Turbo cutoff override cannot be in the future.");
  }
  const cutoffDate = easternCalendarDate(timestamp);
  return {
    cutoffDate,
    cutoffLabel: formatCutoffLabel(cutoffDate),
    cutoffInstant: new Date(timestamp).toISOString(),
  };
}

function validateCutoffDateAndInstant(cutoffDate: string, cutoffInstant: string): void {
  if (!CUTOFF_DATE_PATTERN.test(cutoffDate)) {
    throw new Error("Turbo cutoff date must use YYYY-MM-DD.");
  }
  const timestamp = decodeInstant(cutoffInstant, "Turbo cutoff instant");
  if (easternCalendarDate(timestamp) !== cutoffDate) {
    throw new Error("Turbo cutoff date and instant must identify the same Eastern calendar day.");
  }
}

/** Orders upstream's official Nightly tags. The fork's own versions use {@link compareTurboVersions}. */
export function compareTurboNightlyTags(left: string, right: string): number {
  if (!NIGHTLY_TAG_PATTERN.test(left) || !NIGHTLY_TAG_PATTERN.test(right)) {
    throw new Error("Cannot compare invalid official nightly tags.");
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
  const cutoffInstant = value.cutoffInstant;
  if (cutoffInstant !== undefined && typeof cutoffInstant !== "string") {
    throw new Error("Turbo upstream cutoffInstant must be a string when present.");
  }
  if (typeof cutoffInstant === "string") {
    decodeInstant(cutoffInstant, "Turbo upstream cutoffInstant");
  }
  if (typeof cutoffDate === "string" && typeof cutoffInstant === "string") {
    validateCutoffDateAndInstant(cutoffDate, cutoffInstant);
  }
  const state = {
    repository: value.repository,
    branch: value.branch,
    mainSha: value.mainSha,
    nightlyTag: value.nightlyTag,
    nightlySha: value.nightlySha,
    version: value.version,
    ...(typeof cutoffDate === "string" ? { cutoffDate } : {}),
    ...(typeof cutoffInstant === "string" ? { cutoffInstant } : {}),
  };
  if (!state.repository.trim() || !state.branch.trim()) {
    throw new Error("Turbo upstream repository and branch cannot be empty.");
  }
  if (!NIGHTLY_TAG_PATTERN.test(state.nightlyTag)) {
    throw new Error(`Turbo upstream state has an invalid nightly tag: ${state.nightlyTag}`);
  }
  if (!SHA_PATTERN.test(state.mainSha) || !SHA_PATTERN.test(state.nightlySha)) {
    throw new Error("Turbo upstream state has an invalid commit sha.");
  }
  if (
    !TURBO_NIGHTLY_VERSION_PATTERN.test(state.version) &&
    !LEGACY_TURBO_VERSION_PATTERN.test(state.version)
  ) {
    throw new Error(`Turbo upstream state has an invalid published version: ${state.version}`);
  }
  return state;
}

/** Orders two versions on the fork's own plain-semver line. */
export function compareTurboVersions(left: string, right: string): number {
  const leftParts = TURBO_NIGHTLY_VERSION_PATTERN.exec(left);
  const rightParts = TURBO_NIGHTLY_VERSION_PATTERN.exec(right);
  if (!leftParts || !rightParts) {
    throw new Error("Cannot compare invalid Turbo versions.");
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftParts[index]) - Number(rightParts[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Every published Turbo build is a single patch increase over the previous one. */
export function nextTurboVersion(current: string): string {
  const parts = TURBO_NIGHTLY_VERSION_PATTERN.exec(current);
  if (!parts) throw new Error(`Invalid Turbo version: ${current}`);
  return `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
}

/**
 * Picks the version the next build counts up from. The fork's manifests are authoritative; the
 * recorded state wins only when it is a plain semver ahead of them, so the counter never moves
 * backward. A legacy upstream-derived `state.version` is treated as lower than any plain semver,
 * which is what makes the first run on the new scheme continue from the manifest.
 */
export function selectTurboVersionBase(input: {
  readonly manifestVersion: string;
  readonly stateVersion: string;
}): string {
  if (!TURBO_NIGHTLY_VERSION_PATTERN.test(input.manifestVersion)) {
    throw new Error(`Invalid Turbo manifest version: ${input.manifestVersion}`);
  }
  return TURBO_NIGHTLY_VERSION_PATTERN.test(input.stateVersion) &&
    compareTurboVersions(input.stateVersion, input.manifestVersion) > 0
    ? input.stateVersion
    : input.manifestVersion;
}

export function resolveTurboInboundUpdate(input: {
  readonly state: TurboUpstreamState;
  readonly release: TurboNightlyRelease;
  readonly mainSha: string;
  readonly nightlySha: string;
  /** The fork's current published version, read from `apps/desktop/package.json`. */
  readonly currentVersion: string;
  readonly cutoffDate?: string;
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

  // Upstream movement alone decides whether we build. The fork's version always advances, so
  // including it here would make every run publish even when upstream stood still.
  const hasUpdate = releaseOrder > 0 || input.mainSha !== input.state.mainSha;
  const version = hasUpdate
    ? nextTurboVersion(
        selectTurboVersionBase({
          manifestVersion: input.currentVersion,
          stateVersion: input.state.version,
        }),
      )
    : input.state.version;
  if (hasUpdate && !TURBO_NIGHTLY_TAG_PATTERN.test(`v${version}`)) {
    throw new Error(`Refusing to publish a tag off the Turbo version line: v${version}`);
  }
  if (
    hasUpdate &&
    TURBO_NIGHTLY_VERSION_PATTERN.test(input.state.version) &&
    compareTurboVersions(version, input.state.version) <= 0
  ) {
    throw new Error("Refusing to publish a Turbo build without advancing the version.");
  }
  if (!hasUpdate && version !== input.state.version) {
    throw new Error("Recorded Turbo version must not change when upstream has not moved.");
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

export function selectLatestNightlyRelease(
  value: unknown,
  publishedAtOrBefore?: string,
): TurboNightlyRelease {
  if (!Array.isArray(value)) {
    throw new Error("GitHub releases payload must be an array.");
  }
  const cutoffTimestamp =
    publishedAtOrBefore === undefined
      ? undefined
      : decodeInstant(publishedAtOrBefore, "Nightly publication cutoff");

  const releases = value.flatMap((candidate): ReadonlyArray<TurboNightlyRelease> => {
    if (!isRecord(candidate) || candidate.draft === true || candidate.prerelease !== true)
      return [];
    if (typeof candidate.tag_name !== "string" || typeof candidate.published_at !== "string") {
      return [];
    }
    const match = NIGHTLY_TAG_PATTERN.exec(candidate.tag_name);
    const publishedAt = Date.parse(candidate.published_at);
    if (
      !match?.[1] ||
      Number.isNaN(publishedAt) ||
      (cutoffTimestamp !== undefined && publishedAt > cutoffTimestamp)
    ) {
      return [];
    }
    return [{ tag: candidate.tag_name, version: match[1], publishedAt: candidate.published_at }];
  });

  const latest = releases.toSorted((left, right) => {
    const versionOrder = compareTurboNightlyTags(right.tag, left.tag);
    return versionOrder !== 0
      ? versionOrder
      : Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  })[0];
  if (!latest) {
    throw new Error(
      cutoffTimestamp === undefined
        ? "No published official nightly release was found."
        : `No published official nightly release was found by ${publishedAtOrBefore}.`,
    );
  }
  return latest;
}

export function renderTurboSuccessReport(input: {
  readonly cutoffInstant: string;
  readonly upstreamSha: string;
  readonly nightlyTag: string;
  readonly nightlySha: string;
  readonly priorTurboSha: string;
  readonly resultingTurboSha: string;
  readonly manifestResult: string;
  readonly testResult: string;
  readonly relayPortalRef: string;
  readonly relayPortalBeforeSha: string;
  readonly relayPortalAfterSha: string;
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly releaseUrl: string;
}): string {
  decodeInstant(input.cutoffInstant, "Turbo completion cutoff");
  for (const [label, sha] of [
    ["upstream", input.upstreamSha],
    ["Nightly", input.nightlySha],
    ["prior Turbo", input.priorTurboSha],
    ["resulting Turbo", input.resultingTurboSha],
  ] as const) {
    if (!SHA_PATTERN.test(sha)) throw new Error(`Turbo completion ${label} SHA is invalid.`);
  }
  if (!NIGHTLY_TAG_PATTERN.test(input.nightlyTag)) {
    throw new Error("Turbo completion Nightly tag is invalid.");
  }
  if (!SHA256_PATTERN.test(input.artifactSha256)) {
    throw new Error("Turbo completion artifact SHA-256 is invalid.");
  }
  for (const [label, value] of [
    ["manifest result", input.manifestResult],
    ["test result", input.testResult],
    ["artifact name", input.artifactName],
    ["release URL", input.releaseUrl],
  ] as const) {
    if (!value.trim()) throw new Error(`Turbo completion ${label} cannot be empty.`);
  }
  return [
    "## T3 Turbo nightly completion",
    "",
    `- Cutoff: \`${input.cutoffInstant}\` (11:00 PM America/New_York)`,
    `- Upstream main: \`${input.upstreamSha}\``,
    `- Official Nightly: \`${input.nightlyTag}\` (\`${input.nightlySha}\`)`,
    `- Prior Turbo: \`${input.priorTurboSha}\``,
    `- Resulting Turbo: \`${input.resultingTurboSha}\``,
    `- Customization manifest: ${input.manifestResult}`,
    `- Focused seam tests: ${input.testResult}`,
    `- Relay/portal: ${renderTurboRegisteredRefStatus({
      ref: input.relayPortalRef,
      beforeSha: input.relayPortalBeforeSha,
      afterSha: input.relayPortalAfterSha,
    })}`,
    `- Installer SHA-256: \`${input.artifactSha256}\` (\`${input.artifactName}\`)`,
    `- Release: ${input.releaseUrl}`,
    "",
  ].join("\n");
}

export function renderTurboRegisteredRefStatus(input: {
  readonly ref: string;
  readonly beforeSha: string;
  readonly afterSha: string;
}): string {
  if (!BRANCH_REF_PATTERN.test(input.ref) || input.ref.includes("..") || input.ref.endsWith("/")) {
    throw new Error(
      "Turbo registered infrastructure ref must be a full refs/heads/... branch ref.",
    );
  }
  if (!SHA_PATTERN.test(input.beforeSha) || !SHA_PATTERN.test(input.afterSha)) {
    throw new Error("Turbo registered infrastructure state must contain valid commit SHAs.");
  }
  const branch = input.ref.slice("refs/heads/".length);
  return input.beforeSha === input.afterSha
    ? `registered branch \`${branch}\` remained at \`${input.afterSha}\`; no infrastructure deployment was performed`
    : `registered branch \`${branch}\` changed from \`${input.beforeSha}\` to \`${input.afterSha}\` during the run; no infrastructure deployment was performed by product ingestion`;
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
  readonly mergeError: string;
}): string {
  const section = (title: string, paths: ReadonlyArray<string>) =>
    paths.length === 0
      ? `### ${title}\n\nNone.\n`
      : `### ${title}\n\n${paths.map((path) => `- \`${path}\``).join("\n")}\n`;
  const error = input.mergeError.trim() || "Git did not provide stderr.";
  return [
    "# T3-Turbo nightly merge needs review",
    "",
    `- Previous official nightly: \`${input.oldTag}\` (\`${input.oldSha}\`)`,
    `- Candidate official nightly: \`${input.newTag}\` (\`${input.newSha}\`)`,
    "",
    "The automation stopped without resolving or publishing anything.",
    "",
    section("Files changed by both upstream and Turbo", input.overlappingPaths),
    section("Unmerged paths reported by Git", input.unmergedPaths),
    "### Merge error",
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

/**
 * The fork's current published version. `apps/desktop/package.json` is the authoritative manifest;
 * `--current-version` overrides it so the CLI stays testable outside a checkout.
 */
function readTurboManifestVersion(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const manifest = readJson(
    NodePath.resolve(NodePath.dirname(import.meta.filename), "../apps/desktop/package.json"),
  );
  if (!isRecord(manifest) || typeof manifest.version !== "string") {
    throw new Error("apps/desktop/package.json must contain a version string.");
  }
  return manifest.version;
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
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    !isRecord(candidate) ||
    typeof candidate.sha !== "string" ||
    !SHA_PATTERN.test(candidate.sha)
  ) {
    throw new Error("Official main metadata must contain a valid commit sha.");
  }
  return candidate.sha;
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
    `${JSON.stringify(
      selectLatestNightlyRelease(
        readJson(releasesPath),
        typeof values["cutoff-instant"] === "string" ? values["cutoff-instant"] : undefined,
      ),
      null,
      2,
    )}\n`,
  );
}

function runCutoff(values: Record<string, string | boolean | undefined>): void {
  const now = typeof values.now === "string" ? values.now : new Date();
  // A manual dispatch may pin the cutoff so it can ingest before the scheduled 11 PM Eastern
  // boundary. Scheduled runs leave both the flag and the environment variable empty.
  const override = [
    typeof values["cutoff-instant"] === "string" ? values["cutoff-instant"] : undefined,
    process.env.TURBO_CUTOFF_INSTANT,
  ]
    .map((value) => value?.trim())
    .find((value) => Boolean(value));
  const cutoff =
    override === undefined
      ? resolveTurboEasternCutoff(now)
      : resolveTurboCutoffOverride(override, now);
  const output = {
    cutoff_date: cutoff.cutoffDate,
    cutoff_label: cutoff.cutoffLabel,
    cutoff_instant: cutoff.cutoffInstant,
  };
  if (values["github-output"] === true) appendGitHubOutput(output);
  else process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
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
  const cutoffInstant = values["cutoff-instant"];
  const release = selectLatestNightlyRelease(
    readJson(releasesPath),
    typeof cutoffInstant === "string" ? cutoffInstant : undefined,
  );
  const mainSha = decodeMainSha(readJson(mainPath));
  const comparison = decodeMainComparison(readJson(comparePath));
  const cutoffDate = values["cutoff-date"];
  if ((typeof cutoffDate === "string") !== (typeof cutoffInstant === "string")) {
    throw new Error("resolve requires --cutoff-date and --cutoff-instant together.");
  }
  if (typeof cutoffDate === "string" && typeof cutoffInstant === "string") {
    validateCutoffDateAndInstant(cutoffDate, cutoffInstant);
  }
  const output = resolveTurboInboundUpdate({
    state,
    release,
    mainSha,
    nightlySha: comparison.nightlySha,
    currentVersion: readTurboManifestVersion(
      typeof values["current-version"] === "string" ? values["current-version"] : undefined,
    ),
    ...(typeof cutoffDate === "string" ? { cutoffDate } : {}),
  });
  if (values["github-output"] === true) appendGitHubOutput(output);
  else process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function runSuccessReport(values: Record<string, string | boolean | undefined>): void {
  const outputPath = values.output;
  if (typeof outputPath !== "string") throw new Error("success-report requires --output.");
  const required = [
    "cutoff-instant",
    "upstream-sha",
    "nightly-tag",
    "nightly-sha",
    "prior-turbo-sha",
    "resulting-turbo-sha",
    "manifest-result",
    "test-result",
    "relay-portal-ref",
    "relay-portal-before-sha",
    "relay-portal-after-sha",
    "artifact-name",
    "artifact-sha256",
    "release-url",
  ] as const;
  for (const name of required) {
    if (typeof values[name] !== "string") throw new Error(`success-report requires --${name}.`);
  }
  const report = renderTurboSuccessReport({
    cutoffInstant: values["cutoff-instant"] as string,
    upstreamSha: values["upstream-sha"] as string,
    nightlyTag: values["nightly-tag"] as string,
    nightlySha: values["nightly-sha"] as string,
    priorTurboSha: values["prior-turbo-sha"] as string,
    resultingTurboSha: values["resulting-turbo-sha"] as string,
    manifestResult: values["manifest-result"] as string,
    testResult: values["test-result"] as string,
    relayPortalRef: values["relay-portal-ref"] as string,
    relayPortalBeforeSha: values["relay-portal-before-sha"] as string,
    relayPortalAfterSha: values["relay-portal-after-sha"] as string,
    artifactName: values["artifact-name"] as string,
    artifactSha256: values["artifact-sha256"] as string,
    releaseUrl: values["release-url"] as string,
  });
  NodeFS.mkdirSync(NodePath.dirname(NodePath.resolve(outputPath)), { recursive: true });
  NodeFS.writeFileSync(outputPath, report);
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
  const mergeErrorPath =
    typeof values["merge-error"] === "string" ? values["merge-error"] : undefined;
  const report = renderTurboCollisionReport({
    oldTag: values["old-tag"] as string,
    oldSha: values["old-sha"] as string,
    newTag: values["new-tag"] as string,
    newSha: values["new-sha"] as string,
    overlappingPaths: findPathCollisions(upstreamPaths, customizationPaths),
    unmergedPaths: readPathList(
      typeof values["unmerged-paths"] === "string" ? values["unmerged-paths"] : undefined,
    ),
    mergeError:
      mergeErrorPath && NodeFS.existsSync(mergeErrorPath)
        ? NodeFS.readFileSync(mergeErrorPath, "utf8")
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
      "cutoff-instant": { type: "string" },
      "current-version": { type: "string" },
      // Accepted for workflow compatibility; the fork's version line no longer uses a run sequence.
      "release-sequence": { type: "string" },
      now: { type: "string" },
      "github-output": { type: "boolean" },
      output: { type: "string" },
      "old-tag": { type: "string" },
      "old-sha": { type: "string" },
      "new-tag": { type: "string" },
      "new-sha": { type: "string" },
      "upstream-paths": { type: "string" },
      "customization-paths": { type: "string" },
      "unmerged-paths": { type: "string" },
      "merge-error": { type: "string" },
      "upstream-sha": { type: "string" },
      "nightly-tag": { type: "string" },
      "nightly-sha": { type: "string" },
      "prior-turbo-sha": { type: "string" },
      "resulting-turbo-sha": { type: "string" },
      "manifest-result": { type: "string" },
      "test-result": { type: "string" },
      "relay-portal-ref": { type: "string" },
      "relay-portal-before-sha": { type: "string" },
      "relay-portal-after-sha": { type: "string" },
      "artifact-name": { type: "string" },
      "artifact-sha256": { type: "string" },
      "release-url": { type: "string" },
    },
    strict: true,
  });
  if (command === "cutoff") runCutoff(values);
  else if (command === "latest") runLatest(values);
  else if (command === "resolve") runResolve(values);
  else if (command === "report") runReport(values);
  else if (command === "success-report") runSuccessReport(values);
  else
    throw new Error(
      "Expected command 'cutoff', 'latest', 'resolve', 'report', or 'success-report'.",
    );
}
