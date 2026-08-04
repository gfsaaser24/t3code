export interface OfficialT3ImportActivity {
  readonly activeProviderSessions: number;
  readonly activeProjectedSessions: number;
  readonly activeTurns: number;
  readonly pendingApprovals: number;
}

export interface OfficialT3ImportPlanSummary {
  readonly workspace: {
    readonly sourceActivity: OfficialT3ImportActivity;
    readonly targetActivity: OfficialT3ImportActivity;
  };
  readonly plan: {
    readonly threads: ReadonlyArray<{
      readonly sourceThreadId: string;
      readonly action: string;
    }>;
  };
}

export type OfficialT3ImportPlanClassification =
  | { readonly status: "source-active" }
  | { readonly status: "target-active" }
  | { readonly status: "needs-collision-choices"; readonly threadIds: ReadonlyArray<string> }
  | { readonly status: "ready" };

const activityCount = (activity: OfficialT3ImportActivity): number =>
  activity.activeProviderSessions +
  activity.activeProjectedSessions +
  activity.activeTurns +
  activity.pendingApprovals;

export const classifyPreparedOfficialT3Import = (
  prepared: OfficialT3ImportPlanSummary,
): OfficialT3ImportPlanClassification => {
  if (activityCount(prepared.workspace.sourceActivity) > 0) {
    return { status: "source-active" };
  }
  if (activityCount(prepared.workspace.targetActivity) > 0) {
    return { status: "target-active" };
  }

  const threadIds = prepared.plan.threads
    .filter((thread) => thread.action === "needs-choice")
    .map((thread) => thread.sourceThreadId);
  return threadIds.length > 0
    ? { status: "needs-collision-choices", threadIds }
    : { status: "ready" };
};
