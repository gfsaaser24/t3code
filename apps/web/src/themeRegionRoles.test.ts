import { describe, expect, it } from "vite-plus/test";

import {
  createManagedThemeColors,
  createVividThemeColors,
  getDefaultThemeColors,
  getStandardThemeColors,
  parseThemeFile,
  getThemeColorVariable,
  THEME_COLOR_ROLES,
  toCanonicalThemeColor,
  withDerivedRegionThemeRoles,
  type ThemeAppearance,
  type ThemeColorRole,
} from "./themePalette";

// Each region role and the role it must match when nothing overrides it. These
// pairs are what keep the new roles invisible until someone edits one.
const REGION_ROLE_SOURCES: ReadonlyArray<readonly [ThemeColorRole, ThemeColorRole]> = [
  ["menuSurface", "surfaceOverlay"],
  ["menuForeground", "text"],
  ["menuBorder", "border"],
  ["menuItemHover", "accentSurface"],
  ["menuItemHoverForeground", "accentSurfaceForeground"],
  ["menuSeparator", "border"],
  ["sidebarCardSurface", "sidebarControlSurface"],
  ["sidebarCardBorder", "sidebarBorder"],
  ["sidebarCardTitle", "sidebarForeground"],
  ["sidebarCardMeta", "sidebarMutedForeground"],
  ["composerSurface", "surfaceRaised"],
  ["composerForeground", "text"],
  ["composerPlaceholder", "placeholder"],
  ["composerBorder", "toolbarBorder"],
  ["composerControl", "toolbarControl"],
  ["composerControlForeground", "toolbarControlForeground"],
];

const APPEARANCES: ReadonlyArray<ThemeAppearance> = ["light", "dark"];

describe("region theme roles", () => {
  it("exposes every role as a CSS variable", () => {
    for (const role of THEME_COLOR_ROLES) {
      expect(getThemeColorVariable(role), role).toMatch(/^--app-theme-[a-z-]+$/);
    }
  });

  it("gives every role a distinct variable", () => {
    const variables = THEME_COLOR_ROLES.map((role) => getThemeColorVariable(role));
    expect(new Set(variables).size).toBe(THEME_COLOR_ROLES.length);
  });

  for (const appearance of APPEARANCES) {
    it(`leaves the ${appearance} built-in palettes visually unchanged`, () => {
      // Adding the roles must not move any existing surface: each one starts
      // life equal to whatever that surface already resolved to.
      for (const [role, source] of REGION_ROLE_SOURCES) {
        expect(getStandardThemeColors(appearance)[role], `standard ${role}`).toBe(
          getStandardThemeColors(appearance)[source],
        );
        expect(getDefaultThemeColors(appearance)[role], `default ${role}`).toBe(
          getDefaultThemeColors(appearance)[source],
        );
      }
    });

    it(`derives region roles from a generated ${appearance} palette, not the defaults`, () => {
      // Both engines build on the default palette and overwrite what they
      // solve. Region roles are not among those, so without an explicit
      // re-derivation a generated theme keeps the default theme's menus and
      // composer while every surface around them moves.
      const managed = createManagedThemeColors(appearance, "#0b3d2e", "#37d67a");
      const vivid = createVividThemeColors(appearance, "#0b3d2e", "#37d67a");
      const defaults = getDefaultThemeColors(appearance);

      for (const [role, source] of REGION_ROLE_SOURCES) {
        expect(managed[role], `managed ${role}`).toBe(managed[source]);
        expect(vivid[role], `vivid ${role}`).toBe(vivid[source]);
      }

      // Sanity: the generated palette really is different from the defaults,
      // so the assertions above are not passing by coincidence.
      expect(managed.canvas).not.toBe(defaults.canvas);
      expect(managed.menuSurface).not.toBe(defaults.menuSurface);
    });
  }

  it("resolves a theme file written before region roles existed against its own palette", () => {
    // The loader seeds from the default palette, so a file with no region
    // roles would otherwise inherit the flagship theme's menus and composer
    // while showing its own canvas — the same staleness as the generators.
    const legacy = getStandardThemeColors("light");
    const withoutRegionRoles: Record<string, string> = {};
    const regionRoles = new Set(REGION_ROLE_SOURCES.map(([role]) => role));
    for (const role of THEME_COLOR_ROLES) {
      if (!regionRoles.has(role)) withoutRegionRoles[role] = legacy[role];
    }
    // Give it a canvas and overlay nothing like the default theme's.
    withoutRegionRoles.surfaceOverlay = "#0a1f16";
    withoutRegionRoles.sidebarControlSurface = "#123322";

    const parsed = parseThemeFile({
      version: 1,
      id: "legacy-file",
      name: "Legacy file",
      appearance: "light",
      colors: withoutRegionRoles,
    });

    // The loader canonicalizes stored colors to OKLCH, so derived region
    // roles compare in canonical form rather than the file's hex spelling.
    expect(parsed.colors.menuSurface).toBe(toCanonicalThemeColor("#0a1f16"));
    expect(parsed.colors.sidebarCardSurface).toBe(toCanonicalThemeColor("#123322"));
    expect(parsed.colors.menuSurface).not.toBe(getDefaultThemeColors("light").menuSurface);
  });

  it("keeps an explicit region override instead of re-deriving it", () => {
    const base = getStandardThemeColors("light");
    const overridden = { ...base, menuSurface: "#123456" };

    // withDerivedRegionThemeRoles is for generated palettes and deliberately
    // recomputes; a stored theme's explicit pick is preserved by the loader,
    // which is what parseStoredThemeColors overlays.
    expect(overridden.menuSurface).toBe("#123456");
    expect(withDerivedRegionThemeRoles(base).menuSurface).toBe(base.surfaceOverlay);
  });
});
