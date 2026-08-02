import type { EnvironmentId } from "@t3tools/contracts";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";

interface LandingProject {
  readonly id: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

interface LandingThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt?: string | null;
  readonly archivedAt: string | null;
}

export function selectLandingProject<
  TProject extends LandingProject,
  TThread extends LandingThread,
>(input: {
  readonly projects: readonly TProject[];
  readonly threads: readonly TThread[];
  readonly activeEnvironmentId: EnvironmentId | null;
}): TProject | null {
  const projects =
    input.activeEnvironmentId === null
      ? input.projects
      : input.projects.filter((project) => project.environmentId === input.activeEnvironmentId);
  const threads =
    input.activeEnvironmentId === null
      ? input.threads
      : input.threads.filter((thread) => thread.environmentId === input.activeEnvironmentId);

  return sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null;
}
