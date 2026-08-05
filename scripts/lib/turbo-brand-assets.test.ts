import { describe, expect, it } from "vite-plus/test";

import { resolveTurboWebIconOverrides, TURBO_BRAND_ASSET_PATHS } from "./turbo-brand-assets.ts";

describe("T3 Turbo brand assets", () => {
  it("keeps the supplied source image as the canonical branding input", () => {
    expect(TURBO_BRAND_ASSET_PATHS.sourcePng).toBe("t3turbo.png");
  });

  it("registers purpose-built Turbo masks for Android system surfaces", () => {
    expect(TURBO_BRAND_ASSET_PATHS.androidMonochromeIconPng).toBe(
      "apps/mobile/assets/t3turbo-android-monochrome.png",
    );
    expect(TURBO_BRAND_ASSET_PATHS.androidNotificationIconPng).toBe(
      "apps/mobile/assets/t3turbo-android-notification.png",
    );
  });

  it("maps every web build to the Turbo favicon family", () => {
    expect(resolveTurboWebIconOverrides("dist/client")).toEqual([
      {
        sourceRelativePath: TURBO_BRAND_ASSET_PATHS.webFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: TURBO_BRAND_ASSET_PATHS.webFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: TURBO_BRAND_ASSET_PATHS.webFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: TURBO_BRAND_ASSET_PATHS.webAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ]);
  });
});
