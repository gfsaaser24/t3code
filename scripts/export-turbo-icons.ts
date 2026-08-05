#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import {
  encodePngIcns,
  encodePngIco,
  MAC_ICON_SIZES,
  WINDOWS_ICON_SIZES,
} from "./lib/icon-export.ts";
import { TURBO_BRAND_ASSET_PATHS } from "./lib/turbo-brand-assets.ts";

const checkOnly = process.argv.includes("--check");

class TurboIconRenderError extends Schema.TaggedErrorClass<TurboIconRenderError>()(
  "TurboIconRenderError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Unable to render T3 Turbo icon assets.";
  }
}

class TurboIconAssetsStaleError extends Schema.TaggedErrorClass<TurboIconAssetsStaleError>()(
  "TurboIconAssetsStaleError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Generated T3 Turbo icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

async function renderTurboIcons(sourcePath: string): Promise<Map<string, Buffer>> {
  const sourceMetadata = await sharp(sourcePath).metadata();
  if (
    sourceMetadata.format !== "png" ||
    sourceMetadata.width !== sourceMetadata.height ||
    sourceMetadata.width < 1024
  ) {
    throw new Error(
      `${TURBO_BRAND_ASSET_PATHS.sourcePng} must be a square PNG at least 1024x1024; received ${sourceMetadata.width ?? "?"}x${sourceMetadata.height ?? "?"}.`,
    );
  }

  const pngCache = new Map<number, Promise<Buffer>>();
  const pngAt = (size: number) => {
    const cached = pngCache.get(size);
    if (cached) return cached;

    const rendered = sharp(sourcePath)
      .rotate()
      .resize(size, size, { fit: "cover", kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer();
    pngCache.set(size, rendered);
    return rendered;
  };

  const webpAt = (size: number) =>
    sharp(sourcePath)
      .rotate()
      .resize(size, size, { fit: "cover", kernel: sharp.kernel.lanczos3 })
      .webp({ quality: 95, alphaQuality: 100, smartSubsample: true })
      .toBuffer();

  const monochromeTurboGlyphAt = (size: number) => {
    const blade = '<path d="M50 13c12 0 22 4 30 12-17-1-26 6-29 22-6-9-7-20-1-34Z"/>';
    const blades = Array.from(
      { length: 8 },
      (_, index) => `<g transform="rotate(${index * 45} 50 50)">${blade}</g>`,
    ).join("");
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><g fill="#fff">${blades}<circle cx="50" cy="50" r="9"/></g><circle cx="50" cy="50" r="40" fill="none" stroke="#fff" stroke-width="6"/></svg>`,
    );
    return sharp(svg).png({ compressionLevel: 9, effort: 10 }).toBuffer();
  };

  const icoRenditions = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await pngAt(size) })),
  );
  const icnsRenditions = await Promise.all(
    MAC_ICON_SIZES.map(async (size) => ({ size, contents: await pngAt(size) })),
  );

  const png1024 = await pngAt(1024);
  const favicon16 = await pngAt(16);
  const favicon32 = await pngAt(32);
  const appleTouch = await pngAt(180);
  const desktopPng = await pngAt(512);
  const widgetPng = await pngAt(256);
  const androidMonochrome = await monochromeTurboGlyphAt(432);
  const androidNotification = await monochromeTurboGlyphAt(96);
  const ico = encodePngIco(icoRenditions);
  const icns = encodePngIcns(icnsRenditions);

  return new Map<string, Buffer>([
    [TURBO_BRAND_ASSET_PATHS.iosIconPng, png1024],
    [TURBO_BRAND_ASSET_PATHS.macIconPng, png1024],
    [TURBO_BRAND_ASSET_PATHS.universalIconPng, png1024],
    [TURBO_BRAND_ASSET_PATHS.windowsIconIco, ico],
    [TURBO_BRAND_ASSET_PATHS.desktopIconIcns, icns],
    [TURBO_BRAND_ASSET_PATHS.webFaviconIco, ico],
    [TURBO_BRAND_ASSET_PATHS.webFavicon16Png, favicon16],
    [TURBO_BRAND_ASSET_PATHS.webFavicon32Png, favicon32],
    [TURBO_BRAND_ASSET_PATHS.webAppleTouchIconPng, appleTouch],
    [TURBO_BRAND_ASSET_PATHS.androidMonochromeIconPng, androidMonochrome],
    [TURBO_BRAND_ASSET_PATHS.androidNotificationIconPng, androidNotification],
    [TURBO_BRAND_ASSET_PATHS.widgetIconPng, widgetPng],

    ["apps/web/public/favicon.ico", ico],
    ["apps/web/public/favicon-16x16.png", favicon16],
    ["apps/web/public/favicon-32x32.png", favicon32],
    ["apps/web/public/apple-touch-icon.png", appleTouch],

    ["apps/marketing/public/favicon.ico", ico],
    ["apps/marketing/public/favicon-16x16.png", favicon16],
    ["apps/marketing/public/favicon-32x32.png", favicon32],
    ["apps/marketing/public/apple-touch-icon.png", appleTouch],
    ["apps/marketing/public/icon.png", desktopPng],
    ["apps/marketing/public/favicon-16x16.webp", await webpAt(16)],
    ["apps/marketing/public/favicon-32x32.webp", await webpAt(32)],
    ["apps/marketing/public/apple-touch-icon.webp", await webpAt(180)],
    ["apps/marketing/public/icon.webp", await webpAt(512)],

    ["apps/desktop/resources/icon.ico", ico],
    ["apps/desktop/resources/icon.icns", icns],
    ["apps/desktop/resources/icon.png", desktopPng],
  ]);
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const sourcePath = path.join(repositoryRoot, TURBO_BRAND_ASSET_PATHS.sourcePng);
  const generated = yield* Effect.tryPromise({
    try: () => renderTurboIcons(sourcePath),
    catch: (cause) => new TurboIconRenderError({ cause }),
  });

  const stale: string[] = [];
  for (const [relativePath, expected] of generated) {
    const targetPath = path.join(repositoryRoot, relativePath);
    const actual = yield* fs.readFile(targetPath).pipe(Effect.option);
    if (Option.isSome(actual) && Buffer.from(actual.value).equals(expected)) continue;

    if (checkOnly) {
      stale.push(relativePath);
      continue;
    }

    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
    yield* fs.writeFile(targetPath, expected);
  }

  if (stale.length > 0) {
    return yield* new TurboIconAssetsStaleError({ paths: stale });
  }

  yield* Console.log(
    checkOnly
      ? `All ${generated.size} generated T3 Turbo icon assets are current.`
      : `Updated ${generated.size} T3 Turbo icon assets from ${TURBO_BRAND_ASSET_PATHS.sourcePng}.`,
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
