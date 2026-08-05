import type { EnvironmentId } from "@t3tools/contracts";

export const IMPORT_OFFICIAL_T3_VALUE = "desktop:import-official-t3";

interface EnvironmentOptionInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface DesktopEnvironmentOption extends EnvironmentOptionInput {
  readonly kind: "turbo" | "other";
}

export function buildDesktopEnvironmentOptions(input: {
  readonly environments: readonly EnvironmentOptionInput[];
  readonly primaryEnvironmentId: EnvironmentId | null;
}): readonly DesktopEnvironmentOption[] {
  return input.environments
    .map(
      (environment): DesktopEnvironmentOption =>
        environment.environmentId === input.primaryEnvironmentId
          ? { ...environment, label: "T3 Turbo", kind: "turbo" }
          : { ...environment, kind: "other" },
    )
    .toSorted((left, right) => {
      const rank = { turbo: 0, other: 1 } as const;
      return rank[left.kind] - rank[right.kind] || left.label.localeCompare(right.label);
    });
}

export function applyDesktopEnvironmentSwitch(
  environmentId: EnvironmentId,
  effects: {
    readonly activate: (environmentId: EnvironmentId) => void;
    readonly resetChatWorkspace: () => void;
  },
): void {
  effects.activate(environmentId);
  effects.resetChatWorkspace();
}
