import { describe, expect, it } from "@effect/vitest";

import { classifyPreparedOfficialT3Import } from "./OfficialT3ImportPlan.ts";

const idle = {
  activeProviderSessions: 0,
  activeProjectedSessions: 0,
  activeTurns: 0,
  pendingApprovals: 0,
};

const prepared = (input?: {
  readonly sourceActive?: boolean;
  readonly targetActive?: boolean;
  readonly actions?: ReadonlyArray<readonly [string, string]>;
}) => ({
  workspace: {
    sourceActivity: input?.sourceActive ? { ...idle, activeTurns: 1 } : idle,
    targetActivity: input?.targetActive ? { ...idle, pendingApprovals: 1 } : idle,
  },
  plan: {
    threads: (input?.actions ?? []).map(([sourceThreadId, action]) => ({
      sourceThreadId,
      action,
    })),
  },
});

describe("classifyPreparedOfficialT3Import", () => {
  it("blocks an active source before considering target state or collisions", () => {
    expect(
      classifyPreparedOfficialT3Import(
        prepared({
          sourceActive: true,
          targetActive: true,
          actions: [["thread-1", "needs-choice"]],
        }),
      ),
    ).toEqual({ status: "source-active" });
  });

  it("blocks an active target", () => {
    expect(classifyPreparedOfficialT3Import(prepared({ targetActive: true }))).toEqual({
      status: "target-active",
    });
  });

  it("returns only unresolved thread ids", () => {
    expect(
      classifyPreparedOfficialT3Import(
        prepared({
          actions: [
            ["same-history", "skip-identical"],
            ["conflict-a", "needs-choice"],
            ["new-thread", "import"],
            ["conflict-b", "needs-choice"],
          ],
        }),
      ),
    ).toEqual({
      status: "needs-collision-choices",
      threadIds: ["conflict-a", "conflict-b"],
    });
  });

  it("is ready when both databases are idle and every collision is resolved", () => {
    expect(
      classifyPreparedOfficialT3Import(prepared({ actions: [["resolved", "clone"]] })),
    ).toEqual({ status: "ready" });
  });
});
