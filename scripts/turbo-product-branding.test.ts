// @effect-diagnostics nodeBuiltinImport:off - This repository policy test intentionally reads source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

const repositoryRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const sourceExtensions = new Set([".astro", ".md", ".plist", ".podspec", ".ts", ".tsx"]);
const intentionalUpstreamAttribution = new Set([
  "apps/marketing/src/lib/tweets.ts",
  "apps/mobile/modules/t3-markdown-text/UPSTREAM.md",
]);

function walkSourceFiles(relativeDirectory: string): ReadonlyArray<string> {
  const absoluteDirectory = NodePath.join(repositoryRoot, relativeDirectory);
  return NodeFS.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = NodePath.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return walkSourceFiles(relativePath);
    if (
      !entry.isFile() ||
      entry.name.includes(".test.") ||
      !sourceExtensions.has(NodePath.extname(entry.name))
    ) {
      return [];
    }
    return [relativePath];
  });
}

it("keeps mobile and marketing product copy on T3 Turbo", () => {
  const productFiles = ["apps/mobile", "apps/marketing"].flatMap(walkSourceFiles);
  const failures = productFiles.flatMap((relativePath) => {
    if (intentionalUpstreamAttribution.has(relativePath)) return [];
    const contents = NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");
    const withoutAttribution = contents.replace("Based on T3 Code by T3 Tools Inc", "");
    return withoutAttribution.includes("T3 Code") ? [relativePath] : [];
  });

  assert.deepStrictEqual(failures, []);
});

it("keeps mobile icon slots and marketing downloads on fork-owned Turbo assets", () => {
  const mobileConfig = NodeFS.readFileSync(
    NodePath.join(repositoryRoot, "apps/mobile/app.config.ts"),
    "utf8",
  );
  const marketingReleases = NodeFS.readFileSync(
    NodePath.join(repositoryRoot, "apps/marketing/src/lib/releases.ts"),
    "utf8",
  );

  assert.notInclude(mobileConfig, "android-icon-mark.png");
  assert.notInclude(mobileConfig, "android-notification-icon.png");
  assert.include(mobileConfig, "TURBO_BRAND_ASSET_PATHS.androidMonochromeIconPng");
  assert.include(mobileConfig, "TURBO_BRAND_ASSET_PATHS.androidNotificationIconPng");
  assert.include(marketingReleases, 'const REPO = "gfsaaser24/t3code";');
  assert.notInclude(marketingReleases, 'const REPO = "pingdotgg/t3code";');
});
