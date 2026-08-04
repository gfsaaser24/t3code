import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import { buildDesktopEnvironmentOptions } from "./DesktopEnvironmentSwitcher.logic";

describe("buildDesktopEnvironmentOptions", () => {
  it("labels and orders Turbo before other local or remote environments", () => {
    const turboId = EnvironmentId.make("turbo");

    expect(
      buildDesktopEnvironmentOptions({
        environments: [
          { environmentId: EnvironmentId.make("remote"), label: "Devbox" },
          { environmentId: turboId, label: "Local" },
        ],
        primaryEnvironmentId: turboId,
      }),
    ).toEqual([
      { environmentId: turboId, label: "T3 Turbo", kind: "turbo" },
      { environmentId: "remote", label: "Devbox", kind: "other" },
    ]);
  });
});
