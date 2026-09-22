import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });

  it.each([
    "0.0.31-nightly.20260803.986",
    "0.0.31-nightly.20260803.986.turbo.3",
    "0.0.31-nightly.20260803.986.turbo.20260804.42",
  ])("recognizes Turbo nightly version %s", (version) => {
    expect(isNightlyDesktopVersion(version)).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel(version)).toBe("nightly");
  });

  it.each([
    "0.0.31",
    "0.0.31-nightly.20260803",
    "0.0.31-nightly.20260803.986.turbo",
    "0.0.31-nightly.20260803.986.turbo.2026080.42",
    "0.0.31-nightly.20260803.986.turbo.3.4",
    "0.0.31-nightly.20260803.986.turbo.20260804.42.1",
  ])("keeps stable or malformed version %s on latest", (version) => {
    expect(isNightlyDesktopVersion(version)).toBe(false);
    expect(resolveDefaultDesktopUpdateChannel(version)).toBe("latest");
  });
});
