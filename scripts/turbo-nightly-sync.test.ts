// @effect-diagnostics nodeBuiltinImport:off - This integration test executes the host-side bootstrap CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

import {
  compareTurboNightlyTags,
  createTurboDailyVersion,
  createTurboMainSnapshotVersion,
  decodeTurboUpstreamState,
  findPathCollisions,
  renderTurboCollisionReport,
  renderTurboRegisteredRefStatus,
  renderTurboSuccessReport,
  resolveTurboEasternCutoff,
  resolveTurboInboundUpdate,
  selectLatestNightlyRelease,
} from "./turbo-nightly-sync.ts";

const readWorkflow = (filename: string) =>
  NodeFS.readFileSync(
    NodeURL.fileURLToPath(new URL(`../.github/workflows/${filename}`, import.meta.url)),
    "utf8",
  );

const readTurboWorkflow = () => readWorkflow("turbo-nightly-sync.yml");

it("runs once at the 11 PM Eastern cutoff and names the dated Turbo release", () => {
  const workflow = readTurboWorkflow();

  assert.include(workflow, 'cron: "0 23 * * *"');
  assert.include(workflow, 'timezone: "America/New_York"');
  assert.include(workflow, "node scripts/turbo-nightly-sync.ts cutoff --github-output");
  assert.include(workflow, '--cutoff-instant "$CUTOFF_INSTANT"');
  assert.include(workflow, '-f until="$CUTOFF_INSTANT"');
  assert.include(workflow, "compare/$official_tag...$main_sha");
  assert.include(workflow, '--release-sequence "$GITHUB_RUN_NUMBER"');
  assert.include(workflow, '--title "T3 Turbo $CUTOFF_LABEL.exe"');
  assert.notInclude(workflow, 'cron: "20 */3 * * *"');
});

it("resolves the latest completed 11 PM Eastern cutoff across daylight-saving time", () => {
  assert.deepStrictEqual(resolveTurboEasternCutoff("2026-08-05T03:17:00.000Z"), {
    cutoffDate: "2026-08-04",
    cutoffLabel: "08-04-26",
    cutoffInstant: "2026-08-05T03:00:00.000Z",
  });
  assert.deepStrictEqual(resolveTurboEasternCutoff("2026-08-05T02:59:59.000Z"), {
    cutoffDate: "2026-08-03",
    cutoffLabel: "08-03-26",
    cutoffInstant: "2026-08-04T03:00:00.000Z",
  });
  assert.deepStrictEqual(resolveTurboEasternCutoff("2026-01-15T04:05:00.000Z"), {
    cutoffDate: "2026-01-14",
    cutoffLabel: "01-14-26",
    cutoffInstant: "2026-01-15T04:00:00.000Z",
  });
});

it("keeps the pre-install sync bootstrap dependency-free", () => {
  const source = NodeFS.readFileSync(
    NodeURL.fileURLToPath(new URL("./turbo-nightly-sync.ts", import.meta.url)),
    "utf8",
  );

  assert.notMatch(source, /from ["'](?!node:)[^"']+["']/gu);
});

it("orders nightly tags by version instead of release publication time", () => {
  assert.isAbove(
    compareTurboNightlyTags("v0.0.33-nightly.20260803.2", "v0.0.33-nightly.20260803.1"),
    0,
  );
  assert.deepStrictEqual(
    selectLatestNightlyRelease([
      {
        tag_name: "v0.0.32-nightly.20260802.999",
        prerelease: true,
        draft: false,
        published_at: "2026-08-04T03:00:00Z",
      },
      {
        tag_name: "v0.0.33-nightly.20260803.1",
        prerelease: true,
        draft: false,
        published_at: "2026-08-03T02:00:00Z",
      },
    ]).tag,
    "v0.0.33-nightly.20260803.1",
  );
});

it("selects the newest published official nightly and ignores drafts and stable releases", () => {
  assert.deepStrictEqual(
    selectLatestNightlyRelease([
      {
        tag_name: "v0.0.33-nightly.20260803.2",
        prerelease: true,
        draft: true,
        published_at: "2026-08-03T03:00:00Z",
      },
      {
        tag_name: "v0.0.33-nightly.20260803.1",
        prerelease: true,
        draft: false,
        published_at: "2026-08-03T02:00:00Z",
      },
      {
        tag_name: "v0.0.33",
        prerelease: false,
        draft: false,
        published_at: "2026-08-03T04:00:00Z",
      },
    ]),
    {
      tag: "v0.0.33-nightly.20260803.1",
      version: "0.0.33-nightly.20260803.1",
      publishedAt: "2026-08-03T02:00:00Z",
    },
  );
});

it("excludes official nightlies published after the exact Eastern cutoff", () => {
  assert.strictEqual(
    selectLatestNightlyRelease(
      [
        {
          tag_name: "v0.0.33-nightly.20260804.2",
          prerelease: true,
          draft: false,
          published_at: "2026-08-05T03:00:01Z",
        },
        {
          tag_name: "v0.0.33-nightly.20260804.1",
          prerelease: true,
          draft: false,
          published_at: "2026-08-05T03:00:00Z",
        },
      ],
      "2026-08-05T03:00:00.000Z",
    ).tag,
    "v0.0.33-nightly.20260804.1",
  );
});

it("validates the durable upstream state", () => {
  assert.deepStrictEqual(
    decodeTurboUpstreamState({
      repository: "pingdotgg/t3code",
      branch: "main",
      mainSha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      nightlyTag: "v0.0.32-nightly.20260802.980",
      nightlySha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      version: "0.0.32-nightly.20260802.980",
    }),
    {
      repository: "pingdotgg/t3code",
      branch: "main",
      mainSha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      nightlyTag: "v0.0.32-nightly.20260802.980",
      nightlySha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      version: "0.0.32-nightly.20260802.980",
    },
  );
  assert.throws(() =>
    decodeTurboUpstreamState({
      repository: "pingdotgg/t3code",
      branch: "main",
      mainSha: "not-a-sha",
      nightlyTag: "latest",
      nightlySha: "not-a-sha",
      version: "latest",
    }),
  );
  assert.throws(() =>
    decodeTurboUpstreamState({
      repository: "pingdotgg/t3code",
      branch: "main",
      mainSha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      nightlyTag: "v0.0.32-nightly.20260802.980",
      nightlySha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      version: "0.0.32-nightly.20260802.980.turbo.0",
    }),
  );
  assert.deepInclude(
    decodeTurboUpstreamState({
      repository: "pingdotgg/t3code",
      branch: "main",
      mainSha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      nightlyTag: "v0.0.32-nightly.20260802.980",
      nightlySha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      version: "0.0.32-nightly.20260802.980.turbo.20260804.42",
      cutoffDate: "2026-08-04",
      cutoffInstant: "2026-08-05T03:00:00.000Z",
    }),
    {
      cutoffDate: "2026-08-04",
      cutoffInstant: "2026-08-05T03:00:00.000Z",
    },
  );
  assert.throws(() =>
    decodeTurboUpstreamState({
      repository: "pingdotgg/t3code",
      branch: "main",
      mainSha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      nightlyTag: "v0.0.32-nightly.20260802.980",
      nightlySha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      version: "0.0.32-nightly.20260802.980.turbo.20260804.42",
      cutoffDate: "2026-08-03",
      cutoffInstant: "2026-08-05T03:00:00.000Z",
    }),
  );
});

it("generates deterministic Turbo versions for upstream main snapshots", () => {
  assert.strictEqual(
    createTurboMainSnapshotVersion({
      releaseVersion: "0.0.32-nightly.20260802.980",
      mainDistance: 0,
    }),
    "0.0.32-nightly.20260802.980",
  );
  assert.strictEqual(
    createTurboMainSnapshotVersion({
      releaseVersion: "0.0.32-nightly.20260802.980",
      mainDistance: 3,
    }),
    "0.0.32-nightly.20260802.980.turbo.3",
  );
  assert.isAbove(
    compareTurboNightlyTags(
      "v0.0.32-nightly.20260802.980.turbo.3",
      "v0.0.32-nightly.20260802.980.turbo.2",
    ),
    0,
  );
});

it("generates a unique semver release for each Eastern cutoff and workflow run", () => {
  assert.strictEqual(
    createTurboDailyVersion({
      releaseVersion: "0.0.32-nightly.20260803.986",
      cutoffDate: "2026-08-04",
      releaseSequence: 42,
    }),
    "0.0.32-nightly.20260803.986.turbo.20260804.42",
  );
  assert.throws(() =>
    createTurboDailyVersion({
      releaseVersion: "0.0.32-nightly.20260803.986",
      cutoffDate: "08-04-2026",
      releaseSequence: 42,
    }),
  );
});

it("builds once per daily cutoff even when official source is unchanged", () => {
  const state = {
    repository: "pingdotgg/t3code",
    branch: "main",
    mainSha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
    nightlyTag: "v0.0.32-nightly.20260803.986",
    nightlySha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
    version: "0.0.32-nightly.20260803.986",
  };
  const release = {
    tag: state.nightlyTag,
    version: state.version,
    publishedAt: "2026-08-03T02:00:00Z",
  };

  const daily = resolveTurboInboundUpdate({
    state,
    release,
    mainSha: state.mainSha,
    nightlySha: state.nightlySha,
    mainDistance: 0,
    cutoffDate: "2026-08-04",
    releaseSequence: 42,
  });
  assert.strictEqual(daily.has_update, "true");
  assert.strictEqual(daily.version, "0.0.32-nightly.20260803.986.turbo.20260804.42");
  assert.strictEqual(daily.cutoff_label, "08-04-26");

  assert.strictEqual(
    resolveTurboInboundUpdate({
      state: { ...state, version: daily.version, cutoffDate: "2026-08-04" },
      release,
      mainSha: state.mainSha,
      nightlySha: state.nightlySha,
      mainDistance: 0,
      cutoffDate: "2026-08-04",
      releaseSequence: 42,
    }).has_update,
    "false",
  );
});

it("tracks upstream main commits even when the official release tag is unchanged", () => {
  const state = {
    repository: "pingdotgg/t3code",
    branch: "main",
    mainSha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
    nightlyTag: "v0.0.32-nightly.20260802.980",
    nightlySha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
    version: "0.0.32-nightly.20260802.980",
  };
  const release = {
    tag: state.nightlyTag,
    version: state.version,
    publishedAt: "2026-08-02T09:56:51Z",
  };

  assert.deepStrictEqual(
    resolveTurboInboundUpdate({
      state,
      release,
      mainSha: "ffffffffffffffffffffffffffffffffffffffff",
      nightlySha: state.nightlySha,
      mainDistance: 1,
    }),
    {
      has_update: "true",
      tag: "v0.0.32-nightly.20260802.980.turbo.1",
      version: "0.0.32-nightly.20260802.980.turbo.1",
      official_tag: state.nightlyTag,
      nightly_sha: state.nightlySha,
      source_sha: "ffffffffffffffffffffffffffffffffffffffff",
      old_tag: state.nightlyTag,
      old_nightly_sha: state.nightlySha,
      old_main_sha: state.mainSha,
      old_version: state.version,
      repository: state.repository,
      branch: state.branch,
    },
  );
  assert.strictEqual(
    resolveTurboInboundUpdate({
      state,
      release,
      mainSha: state.mainSha,
      nightlySha: state.nightlySha,
      mainDistance: 0,
    }).has_update,
    "false",
  );
});

it("keeps official source tags separate from fork release tags", () => {
  const workflow = readTurboWorkflow();

  assert.include(workflow, 'main_upstream_ref="refs/t3-turbo/official-heads/$UPSTREAM_BRANCH"');
  assert.include(workflow, 'release_upstream_ref="refs/t3-turbo/official-tags/$OFFICIAL_TAG"');
  assert.notInclude(workflow, '"refs/tags/$OFFICIAL_TAG:refs/tags/$OFFICIAL_TAG"');
});

it("uses only fork-owned GitHub credentials for an unsigned release", () => {
  const workflow = readTurboWorkflow();
  const buildWindowsStart = workflow.indexOf("  build_windows:");
  const publishStart = workflow.indexOf("  publish:");
  const buildWindows = workflow.slice(buildWindowsStart, publishStart);
  const publish = workflow.slice(publishStart);

  assert.include(workflow, "permissions:\n  contents: read");
  assert.notInclude(workflow, "actions/checkout@");
  assert.strictEqual(workflow.match(/git config core\.sparseCheckout true/gu)?.length, 4);
  assert.notInclude(buildWindows, "\n    env:\n");
  assert.include(buildWindows, "T3CODE_DESKTOP_UPDATE_REPOSITORY: ${{ github.repository }}");
  assert.notMatch(buildWindows, /AZURE_|CLERK_|T3CODE_RELAY_URL|--signed|turbo-release/gu);
  assert.include(publish, "permissions:\n      contents: write");
  assert.include(workflow, "rebase --committer-date-is-author-date");
  assert.include(workflow, "pnpm icons:turbo:check");
  assert.include(workflow, "jq -n \\");
  assert.include(workflow, "TURBO_OPENCLAW_ENABLED");
  assert.include(workflow, 'channel: "telegram"');
  assert.include(workflow, "deliver: true");
  assert.notMatch(workflow, /uses: .*telegram/giu);
  assert.notInclude(workflow, "vp run dist:desktop:artifact --");
});

it("measures relay and portal status from the manifest-registered branch ref", () => {
  const workflow = readTurboWorkflow();

  assert.include(workflow, '.registeredRefs[] | select(.id == "relay-portal") | .ref');
  assert.include(workflow, 'before_ref="refs/t3-turbo/registered/relay-portal-before"');
  assert.include(workflow, 'after_ref="refs/t3-turbo/registered/relay-portal-after"');
  assert.include(workflow, '--relay-portal-ref "$RELAY_PORTAL_REF"');
  assert.include(workflow, '--relay-portal-before-sha "$RELAY_PORTAL_BEFORE_SHA"');
  assert.include(workflow, '--relay-portal-after-sha "$RELAY_PORTAL_AFTER_SHA"');
  assert.notInclude(workflow, "--relay-portal-status");
});

it("opens a documented repair issue for manifest, icon, seam, build, and publish failures", () => {
  const workflow = readTurboWorkflow();
  const repairJob = workflow.slice(
    workflow.indexOf("  report_repair:"),
    workflow.indexOf("  notify_openclaw:"),
  );

  assert.include(repairJob, "issues: write");
  assert.include(repairJob, "needs.sync_source.result == 'failure'");
  assert.include(repairJob, "needs.build_windows.result == 'failure'");
  assert.include(repairJob, "manifest, focused-test, icon, native-build");
  assert.include(repairJob, "Open a reviewed PR back to \\`turbo\\`");
  assert.include(repairJob, "pnpm icons:turbo:check");
  assert.include(workflow, "REPAIR_ISSUE_URL: ${{ needs.report_repair.outputs.issue_url }}");
});

it("uses public fork runners and gates the self-host relay on configuration", () => {
  const ciWorkflow = readWorkflow("ci.yml");
  const relayWorkflow = readWorkflow("deploy-relay.yml");

  assert.notMatch(ciWorkflow, /runs-on: blacksmith-/gu);
  assert.strictEqual(ciWorkflow.match(/\|\| 'ubuntu-24\.04'/gu)?.length, 3);
  assert.include(ciWorkflow, "|| 'macos-26'");
  assert.include(ciWorkflow, "group: ci-${{ github.event.pull_request.number || github.ref }}");
  assert.include(ciWorkflow, "cancel-in-progress: true");
  assert.include(relayWorkflow, "name: Detect Cloudflare configuration");
  assert.include(relayWorkflow, "if: steps.cloudflare_config.outputs.enabled == 'true'");
});

it("reports only exact paths changed by upstream and Turbo", () => {
  assert.deepStrictEqual(
    findPathCollisions(
      ["apps/desktop/package.json", "apps/web/src/App.tsx", "apps/web/src/App.tsx"],
      ["scripts/build-desktop-artifact.ts", "apps/desktop/package.json"],
    ),
    ["apps/desktop/package.json"],
  );
});

it("renders a review report without claiming that path overlap is a merge conflict", () => {
  const report = renderTurboCollisionReport({
    oldTag: "v0.0.32-nightly.20260802.980",
    oldSha: "old",
    newTag: "v0.0.33-nightly.20260803.1",
    newSha: "new",
    overlappingPaths: ["apps/desktop/package.json"],
    unmergedPaths: ["scripts/build-desktop-artifact.ts"],
    rebaseError: "CONFLICT (content)",
  });

  assert.include(report, "Files changed by both upstream and Turbo");
  assert.include(report, "Unmerged paths reported by Git");
  assert.include(report, "The automation stopped without resolving or publishing anything.");
  assert.include(report, "CONFLICT (content)");
});

it("renders a complete successful nightly report", () => {
  const report = renderTurboSuccessReport({
    cutoffInstant: "2026-08-05T03:00:00.000Z",
    upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    nightlyTag: "v0.0.33-nightly.20260804.1",
    nightlySha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    priorTurboSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    resultingTurboSha: "cccccccccccccccccccccccccccccccccccccccc",
    manifestResult: "passed (9 seams)",
    testResult: "passed",
    relayPortalRef: "refs/heads/infra/t3turbo-relay",
    relayPortalBeforeSha: "f".repeat(40),
    relayPortalAfterSha: "f".repeat(40),
    artifactName: "T3-Turbo.exe",
    artifactSha256: "d".repeat(64),
    releaseUrl: "https://github.com/gfsaaser24/t3code/releases/tag/v1",
  });

  assert.include(report, "Upstream main: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`");
  assert.include(report, "Official Nightly: `v0.0.33-nightly.20260804.1`");
  assert.include(report, "Prior Turbo: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`");
  assert.include(report, "Resulting Turbo: `cccccccccccccccccccccccccccccccccccccccc`");
  assert.include(report, "Customization manifest: passed (9 seams)");
  assert.include(report, "Focused seam tests: passed");
  assert.include(
    report,
    `Relay/portal: registered branch \`infra/t3turbo-relay\` remained at \`${"f".repeat(40)}\``,
  );
  assert.include(report, "Installer SHA-256");
  assert.include(report, "https://github.com/gfsaaser24/t3code/releases/tag/v1");
});

it("reports registered relay and portal branch movement from measured ref state", () => {
  const status = renderTurboRegisteredRefStatus({
    ref: "refs/heads/infra/t3turbo-relay",
    beforeSha: "a".repeat(40),
    afterSha: "b".repeat(40),
  });

  assert.include(status, "changed from");
  assert.include(status, "during the run");
  assert.throws(() =>
    renderTurboRegisteredRefStatus({
      ref: "infra/t3turbo-relay",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
    }),
  );
});

it("resolves update metadata through the CLI", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "turbo-nightly-sync-"));
  try {
    const statePath = NodePath.join(directory, "upstream.json");
    const releasesPath = NodePath.join(directory, "releases.json");
    const mainPath = NodePath.join(directory, "main.json");
    const comparePath = NodePath.join(directory, "compare.json");
    NodeFS.writeFileSync(
      statePath,
      JSON.stringify({
        repository: "pingdotgg/t3code",
        branch: "main",
        mainSha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
        nightlyTag: "v0.0.32-nightly.20260802.980",
        nightlySha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
        version: "0.0.32-nightly.20260802.980",
      }),
    );
    NodeFS.writeFileSync(
      releasesPath,
      JSON.stringify([
        {
          tag_name: "v0.0.33-nightly.20260803.1",
          prerelease: true,
          draft: false,
          published_at: "2026-08-03T02:00:00Z",
        },
      ]),
    );
    NodeFS.writeFileSync(
      mainPath,
      JSON.stringify([{ sha: "ffffffffffffffffffffffffffffffffffffffff" }]),
    );
    NodeFS.writeFileSync(
      comparePath,
      JSON.stringify({
        status: "ahead",
        ahead_by: 2,
        base_commit: { sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      }),
    );

    const stdout = NodeChildProcess.execFileSync(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./turbo-nightly-sync.ts", import.meta.url)),
        "resolve",
        "--releases",
        releasesPath,
        "--state",
        statePath,
        "--main",
        mainPath,
        "--compare",
        comparePath,
      ],
      { encoding: "utf8" },
    );
    assert.deepStrictEqual(JSON.parse(stdout), {
      has_update: "true",
      tag: "v0.0.33-nightly.20260803.1.turbo.2",
      version: "0.0.33-nightly.20260803.1.turbo.2",
      official_tag: "v0.0.33-nightly.20260803.1",
      nightly_sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      source_sha: "ffffffffffffffffffffffffffffffffffffffff",
      old_tag: "v0.0.32-nightly.20260802.980",
      old_nightly_sha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      old_main_sha: "e60821f0e0d82a5d671ca3b94719c49d333921c8",
      old_version: "0.0.32-nightly.20260802.980",
      repository: "pingdotgg/t3code",
      branch: "main",
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
