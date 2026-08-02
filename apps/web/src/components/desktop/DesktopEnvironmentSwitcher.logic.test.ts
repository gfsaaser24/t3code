import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import {
  buildDesktopEnvironmentOptions,
  resolveOfficialT3PairingInput,
  shouldRefreshOfficialT3Connection,
} from "./DesktopEnvironmentSwitcher.logic";

describe("buildDesktopEnvironmentOptions", () => {
  it("labels and orders Turbo and the official T3 environment first", () => {
    const turboId = EnvironmentId.make("turbo");
    const officialId = EnvironmentId.make("official");

    expect(
      buildDesktopEnvironmentOptions({
        environments: [
          { environmentId: EnvironmentId.make("remote"), label: "Devbox" },
          { environmentId: officialId, label: "Local" },
          { environmentId: turboId, label: "Local" },
        ],
        primaryEnvironmentId: turboId,
        officialEnvironmentId: officialId,
      }),
    ).toEqual([
      { environmentId: turboId, label: "T3 Turbo", kind: "turbo" },
      { environmentId: officialId, label: "T3 Code", kind: "official" },
      { environmentId: "remote", label: "Devbox", kind: "other" },
    ]);
  });

  it("refreshes a saved official connection when the live server port changes", () => {
    expect(shouldRefreshOfficialT3Connection(null, "http://127.0.0.1:48191")).toBe(true);
    expect(
      shouldRefreshOfficialT3Connection("http://127.0.0.1:43123", "http://127.0.0.1:48191"),
    ).toBe(true);
    expect(
      shouldRefreshOfficialT3Connection("http://127.0.0.1:48191/", "http://127.0.0.1:48191"),
    ).toBe(false);
  });

  it("accepts either a pairing link or a bare code", () => {
    expect(
      resolveOfficialT3PairingInput(
        "https://official.example.test/pair#token=once",
        "http://127.0.0.1:43123",
      ),
    ).toEqual({ pairingUrl: "https://official.example.test/pair#token=once" });
    expect(resolveOfficialT3PairingInput(" once ", "http://127.0.0.1:43123")).toEqual({
      host: "http://127.0.0.1:43123",
      pairingCode: "once",
    });
  });
});
