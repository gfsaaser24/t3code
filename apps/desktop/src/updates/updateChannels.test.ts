import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("desktop update channels", () => {
  it.each([
    "0.0.31-nightly.20260803.986",
    "0.0.31-nightly.20260803.986.turbo.3",
    "0.0.31-nightly.20260803.986.turbo.20260804.42",
  ])("recognizes nightly version %s", (version) => {
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
