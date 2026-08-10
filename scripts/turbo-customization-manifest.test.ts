// @effect-diagnostics nodeBuiltinImport:off - This test exercises the dependency-free host-side verifier.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

import {
  decodeTurboCustomizationManifest,
  verifyTurboCustomizationManifest,
} from "./turbo-customization-manifest.ts";

const repositoryRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const fixtureManifest = (
  checks: ReadonlyArray<{ path: string; markers: ReadonlyArray<string> }>,
) => ({
  schemaVersion: 1,
  product: "T3 Turbo",
  registeredRefs: [{ id: "fixture-ref", ref: "refs/heads/infra/fixture" }],
  seams: [
    {
      id: "fixture-seam",
      status: "implemented",
      summary: "Fixture seam.",
      checks,
    },
  ],
});

function withTemporaryRepository(run: (root: string) => void): void {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-turbo-manifest-"));
  try {
    NodeFS.mkdirSync(NodePath.join(root, ".t3-turbo"), { recursive: true });
    run(root);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

it("keeps the pre-install manifest verifier dependency-free", () => {
  const source = NodeFS.readFileSync(
    NodeURL.fileURLToPath(new URL("./turbo-customization-manifest.ts", import.meta.url)),
    "utf8",
  );

  assert.notMatch(source, /from ["'](?!node:)[^"']+["']/gu);
});

it("verifies files and stable content markers without whole-file hashes", () => {
  withTemporaryRepository((root) => {
    NodeFS.writeFileSync(NodePath.join(root, "feature.ts"), "export const feature = 'present';\n");
    NodeFS.writeFileSync(
      NodePath.join(root, ".t3-turbo", "customizations.json"),
      JSON.stringify(fixtureManifest([{ path: "feature.ts", markers: ["feature", "present"] }])),
    );

    const result = verifyTurboCustomizationManifest({ root });

    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(result.checkCount, 1);
  });
});

it("reports every missing file and marker with its owning seam", () => {
  withTemporaryRepository((root) => {
    NodeFS.writeFileSync(NodePath.join(root, "feature.ts"), "export const feature = 'present';\n");
    NodeFS.writeFileSync(
      NodePath.join(root, ".t3-turbo", "customizations.json"),
      JSON.stringify(
        fixtureManifest([
          { path: "feature.ts", markers: ["removed marker"] },
          { path: "missing.ts", markers: [] },
        ]),
      ),
    );

    assert.deepStrictEqual(verifyTurboCustomizationManifest({ root }).failures, [
      {
        seamId: "fixture-seam",
        path: "feature.ts",
        reason: 'missing content marker "removed marker"',
      },
      { seamId: "fixture-seam", path: "missing.ts", reason: "file is missing" },
    ]);
  });
});

it("rejects ambiguous lifecycles and non-portable repository paths", () => {
  assert.throws(() =>
    decodeTurboCustomizationManifest({
      ...fixtureManifest([{ path: "feature.ts", markers: [] }]),
      seams: [
        {
          id: "bad-seam",
          status: "shipped",
          summary: "Bad fixture.",
          checks: [{ path: "feature.ts", markers: [] }],
        },
      ],
    }),
  );
  assert.throws(() =>
    decodeTurboCustomizationManifest(fixtureManifest([{ path: "../outside.ts", markers: [] }])),
  );
  assert.throws(() =>
    decodeTurboCustomizationManifest(
      fixtureManifest([{ path: "folder\\feature.ts", markers: [] }]),
    ),
  );
  assert.throws(() =>
    decodeTurboCustomizationManifest({
      ...fixtureManifest([{ path: "feature.ts", markers: [] }]),
      registeredRefs: [{ id: "fixture-ref", ref: "infra/fixture" }],
    }),
  );
  assert.throws(() =>
    decodeTurboCustomizationManifest({
      ...fixtureManifest([{ path: "feature.ts", markers: [] }]),
      registeredRefs: [
        { id: "fixture-ref", ref: "refs/heads/infra/fixture" },
        { id: "fixture-ref", ref: "refs/heads/infra/other" },
      ],
    }),
  );
});

it("verifies the checked-in Turbo manifest and tracks the implemented multi-chat seam", () => {
  const result = verifyTurboCustomizationManifest({ root: repositoryRoot });
  const multiChat = result.manifest.seams.find((seam) => seam.id === "multi-chat-pane-workspace");
  const markdown = result.manifest.seams.find((seam) => seam.id === "markdown-preview-preference");
  const imagePreview = result.manifest.seams.find((seam) => seam.id === "workspace-image-preview");
  const officialImport = result.manifest.seams.find((seam) => seam.id === "official-data-import");
  const icons = result.manifest.seams.find((seam) => seam.id === "canonical-icon-pipeline");
  const nightly = result.manifest.seams.find((seam) => seam.id === "nightly-and-secret-policy");
  const product = result.manifest.seams.find((seam) => seam.id === "product-identity-and-updater");

  assert.deepStrictEqual(result.failures, []);
  assert.deepStrictEqual(result.manifest.registeredRefs, [
    { id: "relay-portal", ref: "refs/heads/infra/t3turbo-relay" },
  ]);
  assert.deepStrictEqual(result.manifest.seams.map((seam) => seam.id).sort(), [
    "agent-docs-operating-model",
    "canonical-icon-pipeline",
    "changelog-and-runbook",
    "cheap-message-unpacking",
    "cheap-timestamp-and-sort-keys",
    "deferred-streaming-code-blocks",
    "file-explorer",
    "markdown-preview-preference",
    "multi-chat-pane-workspace",
    "nightly-and-secret-policy",
    "official-data-import",
    "pooled-subscription-frame",
    "product-identity-and-updater",
    "relay-apns-off-publish-skip",
    "relay-auth-and-link-memos",
    "relay-policy",
    "relay-request-budget-and-clerk-client",
    "settled-lifecycle-sticky-pin",
    "shared-sha256-base64url",
    "sqlite-fast-mode-pragma",
    "streaming-flag-cleared-on-turn-settle",
    "terminal-buffer-byte-budget",
    "terminal-drawer-redraw-gate",
    "terminal-scrollback-batching",
    "unified-activity-order",
    "workspace-image-preview",
  ]);
  assert.strictEqual(multiChat?.status, "implemented");
  assert.isTrue(
    multiChat?.checks.some((check) => check.path.startsWith("apps/web/src/turbo/chatPanes/")),
  );
  // Upstream 0de954073 renamed SidebarV2.tsx to Sidebar.tsx; the pane seam's
  // marker moved with it, so only the surviving path is registered.
  assert.deepStrictEqual(
    multiChat?.checks
      .map((check) => check.path)
      .filter(
        (path) =>
          path === "apps/web/src/components/Sidebar.tsx" ||
          path === "apps/web/src/components/SidebarV2.tsx",
      )
      .sort(),
    ["apps/web/src/components/Sidebar.tsx"],
  );
  assert.isTrue(
    multiChat?.checks.some((check) => check.path.endsWith("chatPanePersistence.test.ts")),
  );
  assert.isTrue(
    multiChat?.checks.some((check) => check.path.endsWith("chatPaneResourcePolicy.test.ts")),
  );
  assert.isTrue(
    [
      "apps/web/src/routes/_chat.tsx",
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/components/chat/ChatHeader.tsx",
      "apps/web/src/terminalUiStateStore.ts",
      "apps/web/src/rightPanelStore.ts",
    ].every((path) => multiChat?.checks.some((check) => check.path === path)),
  );
  assert.isTrue(
    markdown?.checks.some(
      (check) => check.path === "apps/web/src/components/chat/markdownFileLinkGesture.test.ts",
    ),
  );
  assert.isTrue(
    markdown?.checks.some(
      (check) => check.path === "apps/server/src/process/externalLauncher.test.ts",
    ),
  );
  assert.isTrue(
    markdown?.checks.some(
      (check) => check.path === "apps/web/src/components/settings/SettingsSidebarNav.tsx",
    ),
  );
  assert.isTrue(
    [
      "packages/client-runtime/src/state/shellCommands.ts",
      "apps/web/src/state/shell.ts",
      "apps/web/src/components/ChatMarkdown.tsx",
    ].every((path) => markdown?.checks.some((check) => check.path === path)),
  );
  assert.isTrue(
    imagePreview?.checks.some((check) => check.path === "apps/web/src/rightPanelStore.ts"),
  );
  assert.isTrue(
    [
      "apps/server/src/cli/officialImport.ts",
      "apps/server/src/bin.ts",
      "packages/contracts/src/ipc.ts",
      "apps/desktop/src/ipc/channels.ts",
      "apps/desktop/src/ipc/DesktopIpcHandlers.ts",
      "apps/desktop/src/preload.ts",
      "apps/desktop/src/ipc/methods/officialT3Environment.ts",
    ].every((path) => officialImport?.checks.some((check) => check.path === path)),
  );
  assert.isTrue(
    [
      "apps/mobile/assets/t3turbo-android-monochrome.png",
      "apps/mobile/assets/t3turbo-android-notification.png",
      "scripts/turbo-product-branding.test.ts",
    ].every((path) => icons?.checks.some((check) => check.path === path)),
  );
  assert.isTrue(
    nightly?.checks.some((check) => check.markers.includes("Do not publish T3 Turbo to NPM")),
  );
  assert.isTrue(product?.checks.some((check) => check.markers.includes("--publish never")));
  const releaseWorkflow = NodeFS.readFileSync(
    NodePath.join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  assert.notInclude(releaseWorkflow, "Publish CLI to npm");
  assert.notInclude(releaseWorkflow, "npm publish");
});

it("verifies the rebased candidate before the nightly workflow bundles it", () => {
  const workflow = NodeFS.readFileSync(
    NodePath.join(repositoryRoot, ".github", "workflows", "turbo-nightly-sync.yml"),
    "utf8",
  );
  const verificationIndex = workflow.indexOf(
    'node scripts/turbo-customization-manifest.ts verify --root "$sync_worktree"',
  );
  const bundleIndex = workflow.indexOf("bundle create");

  assert.isAtLeast(verificationIndex, 0);
  assert.isAbove(bundleIndex, verificationIndex);
});
