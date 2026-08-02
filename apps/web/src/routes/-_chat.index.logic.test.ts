import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { selectLandingProject } from "./-_chat.index.logic";

describe("selectLandingProject", () => {
  it("chooses the most recent project only from the selected environment", () => {
    const turbo = EnvironmentId.make("turbo");
    const official = EnvironmentId.make("official");
    const projects = [
      { id: "turbo-project", title: "Turbo", environmentId: turbo },
      { id: "official-project", title: "Official", environmentId: official },
    ];
    const threads = [
      {
        environmentId: turbo,
        projectId: "turbo-project",
        createdAt: "2026-08-02T12:00:00.000Z",
        updatedAt: "2026-08-02T12:00:00.000Z",
        archivedAt: null,
      },
      {
        environmentId: official,
        projectId: "official-project",
        createdAt: "2026-08-02T11:00:00.000Z",
        updatedAt: "2026-08-02T11:00:00.000Z",
        archivedAt: null,
      },
    ];

    expect(selectLandingProject({ projects, threads, activeEnvironmentId: official })).toEqual(
      projects[1],
    );
  });
});
