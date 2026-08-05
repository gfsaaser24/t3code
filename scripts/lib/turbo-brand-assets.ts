export const TURBO_BRAND_ASSET_PATHS = {
  sourcePng: "t3turbo.png",

  iosIconPng: "assets/turbo/t3turbo-ios-1024.png",
  macIconPng: "assets/turbo/t3turbo-macos-1024.png",
  universalIconPng: "assets/turbo/t3turbo-universal-1024.png",
  windowsIconIco: "assets/turbo/t3turbo-windows.ico",
  desktopIconIcns: "assets/turbo/t3turbo.icns",

  webFaviconIco: "assets/turbo/t3turbo-web-favicon.ico",
  webFavicon16Png: "assets/turbo/t3turbo-web-favicon-16x16.png",
  webFavicon32Png: "assets/turbo/t3turbo-web-favicon-32x32.png",
  webAppleTouchIconPng: "assets/turbo/t3turbo-web-apple-touch-180.png",

  androidMonochromeIconPng: "apps/mobile/assets/t3turbo-android-monochrome.png",
  androidNotificationIconPng: "apps/mobile/assets/t3turbo-android-notification.png",
  widgetIconPng: "apps/mobile/assets/widget/T3Mark.png",
} as const;

export interface TurboIconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

export function resolveTurboWebIconOverrides(
  targetDirectory: string,
): ReadonlyArray<TurboIconOverride> {
  return [
    {
      sourceRelativePath: TURBO_BRAND_ASSET_PATHS.webFaviconIco,
      targetRelativePath: `${targetDirectory}/favicon.ico`,
    },
    {
      sourceRelativePath: TURBO_BRAND_ASSET_PATHS.webFavicon16Png,
      targetRelativePath: `${targetDirectory}/favicon-16x16.png`,
    },
    {
      sourceRelativePath: TURBO_BRAND_ASSET_PATHS.webFavicon32Png,
      targetRelativePath: `${targetDirectory}/favicon-32x32.png`,
    },
    {
      sourceRelativePath: TURBO_BRAND_ASSET_PATHS.webAppleTouchIconPng,
      targetRelativePath: `${targetDirectory}/apple-touch-icon.png`,
    },
  ];
}
