import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  invalidateCustomThemes,
  removeCustomTheme,
  THEME_COLOR_ROLES,
} from "../../themePalette";
import { seedBundledThemes, TURBO_SEEDED_THEMES_STORAGE_KEY } from "./bundledThemes";

const HEROUI_ID = "heroui-pro";

// The web suite runs without a DOM, so stand up just the storage surface the
// theme library touches (same approach as themeBoot.test.ts).
function stubWindowStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  return store;
}

let store: Record<string, string>;

beforeEach(() => {
  store = stubWindowStorage();
  invalidateCustomThemes();
});

const heroui = () => getCustomThemes().find((theme) => theme.id === HEROUI_ID);

describe("bundled Turbo themes", () => {
  it("installs the HeroUI palette on a cold profile", () => {
    expect(getCustomThemes()).toHaveLength(0);

    seedBundledThemes();

    expect(heroui()).toBeDefined();
    expect(heroui()?.label).toBe("HeroUI Pro");
  });

  it("carries every color role in both appearances", () => {
    seedBundledThemes();
    const theme = heroui();

    for (const role of THEME_COLOR_ROLES) {
      expect(theme?.colors[role], `light ${role}`).toMatch(/^#[0-9a-f]{3,8}$/i);
      expect(theme?.variants?.dark?.[role], `dark ${role}`).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });

  it("uses a non-reserved id so the theme editor can save edits", () => {
    seedBundledThemes();
    // A reserved id makes updateCustomTheme throw, which is what would make the
    // palette read-only in the editor.
    expect(() => removeCustomTheme(HEROUI_ID)).not.toThrow();
    expect(heroui()).toBeUndefined();
  });

  it("does not reinstall a theme the user deleted", () => {
    seedBundledThemes();
    removeCustomTheme(HEROUI_ID);
    expect(heroui()).toBeUndefined();

    seedBundledThemes();

    expect(heroui()).toBeUndefined();
  });

  it("does not duplicate on repeated boots", () => {
    seedBundledThemes();
    seedBundledThemes();
    seedBundledThemes();

    expect(getCustomThemes().filter((theme) => theme.id === HEROUI_ID)).toHaveLength(1);
  });

  it("preserves user edits across a later boot", () => {
    seedBundledThemes();
    const stored = JSON.parse(store[CUSTOM_THEMES_STORAGE_KEY] ?? "[]");
    stored[0].colors.accent = "#0000ff";
    store[CUSTOM_THEMES_STORAGE_KEY] = JSON.stringify(stored);
    invalidateCustomThemes();

    seedBundledThemes();

    expect(heroui()?.colors.accent).toBe("#0000ff");
  });

  it("survives an unreadable seed marker", () => {
    store[TURBO_SEEDED_THEMES_STORAGE_KEY] = "{not json";

    expect(() => seedBundledThemes()).not.toThrow();
    expect(heroui()).toBeDefined();
  });
});
