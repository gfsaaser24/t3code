/**
 * Themes T3 Turbo ships with, installed as ordinary custom themes.
 *
 * They are deliberately not registered as built-ins: `RESERVED_THEME_IDS`
 * makes `updateCustomTheme` throw, so a built-in is read-only in the theme
 * editor. Seeding them as custom themes instead means they open in the editor
 * like any imported palette and every one of the 57 roles stays adjustable.
 *
 * Seeding is once-only per theme id. A theme the user deleted must stay
 * deleted, so the marker records "we have offered this", not "this is
 * installed". Nothing here may throw: a corrupt or unavailable localStorage
 * must not stop the app from booting.
 */
import { getCustomThemes, installCustomTheme, parseThemeFile } from "../../themePalette";

import herouiProThemeFile from "./heroui-pro.json" with { type: "json" };

const SEEDED_THEMES_STORAGE_KEY = "t3code:turbo-seeded-themes:v1";

const BUNDLED_THEME_FILES: ReadonlyArray<unknown> = [herouiProThemeFile];

function readSeededThemeIds(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(SEEDED_THEMES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    // An unreadable marker is treated as "nothing seeded yet" rather than a
    // failure; the install guard below still prevents duplicates.
    return new Set();
  }
}

function writeSeededThemeIds(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(SEEDED_THEMES_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage is full or blocked. The themes that installed this run stay
    // installed; the next boot simply re-offers the ones that did not.
  }
}

export function seedBundledThemes(): void {
  if (typeof window === "undefined") return;

  const alreadyOffered = readSeededThemeIds();
  const nextOffered = new Set(alreadyOffered);
  let changed = false;

  for (const file of BUNDLED_THEME_FILES) {
    let theme;
    try {
      theme = parseThemeFile(file);
    } catch {
      // A malformed bundled theme is a build-time mistake, not a runtime
      // failure. Skip it rather than taking the app down.
      continue;
    }

    if (alreadyOffered.has(theme.id)) continue;

    const installed = getCustomThemes().some((existing) => existing.id === theme.id);
    if (installed) {
      nextOffered.add(theme.id);
      changed = true;
      continue;
    }

    try {
      installCustomTheme(theme);
      nextOffered.add(theme.id);
      changed = true;
    } catch {
      // Leave the id unmarked so a transient storage failure is retried on the
      // next boot instead of silently dropping the theme forever.
    }
  }

  if (changed) writeSeededThemeIds(nextOffered);
}

export const TURBO_SEEDED_THEMES_STORAGE_KEY = SEEDED_THEMES_STORAGE_KEY;
