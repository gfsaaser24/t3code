import type { EnvironmentId } from "@t3tools/contracts";

export const CONNECT_OFFICIAL_T3_VALUE = "desktop:connect-official-t3";

interface EnvironmentOptionInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface DesktopEnvironmentOption extends EnvironmentOptionInput {
  readonly kind: "turbo" | "official" | "other";
}

function normalizeComparableUrl(value: string): string {
  return value.replace(/\/$/u, "");
}

export function shouldRefreshOfficialT3Connection(
  savedHttpBaseUrl: string | null,
  discoveredHttpBaseUrl: string,
): boolean {
  return (
    savedHttpBaseUrl === null ||
    normalizeComparableUrl(savedHttpBaseUrl) !== normalizeComparableUrl(discoveredHttpBaseUrl)
  );
}

export function resolveOfficialT3PairingInput(
  value: string,
  httpBaseUrl: string,
): { readonly pairingUrl: string } | { readonly host: string; readonly pairingCode: string } {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { pairingUrl: trimmed };
    }
  } catch {
    // A bare value is the one-time pairing code for the discovered server.
  }
  return { host: httpBaseUrl, pairingCode: trimmed };
}

export function buildDesktopEnvironmentOptions(input: {
  readonly environments: readonly EnvironmentOptionInput[];
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly officialEnvironmentId: EnvironmentId | null;
}): readonly DesktopEnvironmentOption[] {
  return input.environments
    .map((environment): DesktopEnvironmentOption => {
      if (environment.environmentId === input.primaryEnvironmentId) {
        return { ...environment, label: "T3 Turbo", kind: "turbo" };
      }
      if (environment.environmentId === input.officialEnvironmentId) {
        return { ...environment, label: "T3 Code", kind: "official" };
      }
      return { ...environment, kind: "other" };
    })
    .toSorted((left, right) => {
      const rank = { turbo: 0, official: 1, other: 2 } as const;
      return rank[left.kind] - rank[right.kind] || left.label.localeCompare(right.label);
    });
}
