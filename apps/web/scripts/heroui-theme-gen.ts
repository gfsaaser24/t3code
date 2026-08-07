/**
 * Generates a T3 Code ThemeFile from the HeroUI Pro token set.
 *
 * Strategy: seed T3's own `createManagedThemeColors` with HeroUI's background
 * and accent so every role T3 needs but HeroUI never defines (message*, code*,
 * terminal cursor/selection, accentSurface*, the *Foreground contrast pairs) is
 * solved by T3's real algorithm rather than guessed. Then hard-override every
 * role HeroUI actually specifies.
 *
 * The overrides matter more than they look: the managed derivation mixes the
 * accent into sidebar, secondary, muted, toolbarControl and messageSurface. With
 * a saturated orange accent that would wash the whole shell orange, while
 * HeroUI Pro is a strictly neutral grey system that spends colour only on
 * genuinely accented elements. Pinning the neutrals back is what keeps it
 * looking like HeroUI.
 */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import {
  createManagedThemeColors,
  parseThemeFile,
  serializeThemeFile,
  THEME_COLOR_ROLES,
  type ThemeColorRole,
  type ThemeColors,
} from "../src/themePalette.ts";

type Overrides = Partial<Record<ThemeColorRole, string>>;

// HeroUI Pro seeds (OKLCH converted to the hex form ThemeFile requires).
const LIGHT_BG = "#f5f5f5";
const DARK_BG = "#060606";
const ACCENT = "#fa6401";

const light: Overrides = {
  canvas: LIGHT_BG,
  chrome: LIGHT_BG,
  toolbar: LIGHT_BG,
  toolbarForeground: "#18181b",
  toolbarBorder: "#dedede",
  toolbarControl: "#ebebeb",
  toolbarControlHover: "#eaeaea",
  surface: "#ffffff",
  surfaceRaised: "#efefef",
  surfaceOverlay: "#ffffff",
  text: "#18181b",
  textMuted: "#727272",
  border: "#dedede",
  input: "#ffffff",
  focus: ACCENT,
  accent: ACCENT,
  secondary: "#ebebeb",
  muted: "#ebebeb",
  mutedForeground: "#727272",
  placeholder: "#727272",
  secondaryLabel: "#727272",
  iconMuted: "#727272",
  error: "#d92d20",
  warning: "#ff9557",
  messageSurface: "#efefef",
  messageForeground: "#18181b",
  messageAction: "#ebebeb",
  messageActionHover: "#eaeaea",
  codeBackground: "#efefef",
  codeForeground: "#18181b",
  sidebar: LIGHT_BG,
  sidebarForeground: "#18181b",
  sidebarMutedForeground: "#727272",
  sidebarControlSurface: "#ebebeb",
  sidebarRowHover: "#efefef",
  sidebarRowActive: "#eaeaea",
  sidebarRowSelected: "#eaeaea",
  sidebarBorder: "#dedede",
  terminalBackground: "#ffffff",
  terminalForeground: "#18181b",
  terminalScrollbar: "#d4d4d4",
  terminalScrollbarHover: "#c4c4c4",
  // T3's derivation solves these against its own default palette, which is
  // magenta-tinted (#241523). HeroUI's ink is neutral, so pin them.
  accentForeground: "#18181b",
  toolbarControlForeground: "#18181b",
  secondaryForeground: "#18181b",
  accentSurfaceForeground: "#18181b",
  messageActionForeground: "#18181b",
};

const dark: Overrides = {
  canvas: DARK_BG,
  chrome: DARK_BG,
  toolbar: DARK_BG,
  toolbarForeground: "#fcfcfc",
  toolbarBorder: "#292929",
  toolbarControl: "#272727",
  surface: "#181818",
  surfaceRaised: "#232323",
  surfaceOverlay: "#181818",
  text: "#fcfcfc",
  textMuted: "#a0a0a0",
  border: "#292929",
  input: "#181818",
  focus: ACCENT,
  accent: ACCENT,
  secondary: "#272727",
  muted: "#272727",
  mutedForeground: "#a0a0a0",
  placeholder: "#a0a0a0",
  secondaryLabel: "#a0a0a0",
  iconMuted: "#a0a0a0",
  error: "#f04438",
  warning: "#ffa96d",
  messageSurface: "#232323",
  messageForeground: "#fcfcfc",
  messageAction: "#272727",
  codeBackground: "#181818",
  codeForeground: "#fcfcfc",
  sidebar: DARK_BG,
  sidebarForeground: "#fcfcfc",
  sidebarMutedForeground: "#a0a0a0",
  sidebarControlSurface: "#272727",
  sidebarRowHover: "#181818",
  sidebarRowActive: "#232323",
  sidebarRowSelected: "#232323",
  sidebarBorder: "#292929",
  terminalBackground: DARK_BG,
  terminalForeground: "#fcfcfc",
  terminalScrollbar: "#a0a0a0",
  terminalScrollbarHover: "#8f8f8f",
  toolbarControlHover: "#323232",
  messageActionHover: "#323232",
  // Accent is the same orange in both modes, so its ink stays the dark
  // neutral. The rest follow the dark foreground.
  accentForeground: "#18181b",
  toolbarControlForeground: "#fcfcfc",
  secondaryForeground: "#fcfcfc",
  accentSurfaceForeground: "#fcfcfc",
  // messageAction is a neutral #272727 surface here, so its ink is light.
  messageActionForeground: "#fcfcfc",
};

function build(
  appearance: "light" | "dark",
  background: string,
  overrides: Overrides,
): ThemeColors {
  const derived = createManagedThemeColors(appearance, background, ACCENT, { exactSeeds: true });
  return { ...derived, ...overrides } as ThemeColors;
}

const lightColors = build("light", LIGHT_BG, light);
const darkColors = build("dark", DARK_BG, dark);

const file = {
  version: 1 as const,
  id: "heroui-pro",
  name: "HeroUI Pro",
  appearance: "light" as const,
  // `colors` carries the base appearance; `variants` may only carry the other
  // one (parseThemeFile rejects a variant that repeats the base).
  colors: lightColors,
  variants: { dark: darkColors },
};

// Round-trip through T3's own validator so we ship nothing the app would reject.
const parsed = parseThemeFile(file);
const serialized = serializeThemeFile(parsed);

const missing = THEME_COLOR_ROLES.filter((role) => !(role in lightColors) || !(role in darkColors));
if (missing.length > 0) throw new Error(`Missing roles: ${missing.join(", ")}`);

const derivedLight = createManagedThemeColors("light", LIGHT_BG, ACCENT, { exactSeeds: true });
const derivedDark = createManagedThemeColors("dark", DARK_BG, ACCENT, { exactSeeds: true });

console.log(`roles: ${THEME_COLOR_ROLES.length}`);
console.log(
  `explicit light: ${Object.keys(light).length}  derived light: ${THEME_COLOR_ROLES.length - Object.keys(light).length}`,
);
console.log(
  `explicit dark:  ${Object.keys(dark).length}  derived dark:  ${THEME_COLOR_ROLES.length - Object.keys(dark).length}`,
);
console.log(`\nroles left to T3's derivation (light):`);
for (const role of THEME_COLOR_ROLES) {
  if (!(role in light))
    console.log(`  ${role.padEnd(28)} ${derivedLight[role]}   dark ${derivedDark[role]}`);
}

const outputPath = new URL("../src/turbo/themes/heroui-pro.json", import.meta.url);
NodeFS.writeFileSync(outputPath, serialized.endsWith("\n") ? serialized : `${serialized}\n`);
console.log(`\nwrote ${NodeURL.fileURLToPath(outputPath)}`);
