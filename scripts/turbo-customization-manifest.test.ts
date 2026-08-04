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
});

it("verifies the checked-in Turbo manifest and tracks the implemented multi-chat seam", () => {
  const result = verifyTurboCustomizationManifest({ root: repositoryRoot });
  const multiChat = result.manifest.seams.find((seam) => seam.id === "multi-chat-pane-workspace");

  assert.deepStrictEqual(result.failures, []);
  assert.deepStrictEqual(result.manifest.seams.map((seam) => seam.id).sort(), [
    "canonical-icon-pipeline",
    "file-explorer",
    "markdown-preview-preference",
    "multi-chat-pane-workspace",
    "nightly-and-secret-policy",
    "official-data-import",
    "product-identity-and-updater",
    "relay-policy",
    "workspace-image-preview",
  ]);
  assert.strictEqual(multiChat?.status, "implemented");
  assert.isTrue(
    multiChat?.checks.some((check) => check.path.startsWith("apps/web/src/turbo/chatPanes/")),
  );
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
