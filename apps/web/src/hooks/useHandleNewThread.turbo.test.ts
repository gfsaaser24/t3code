import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import { resolveNewThreadSourceTarget } from "./useHandleNewThread";

const routeTarget: ThreadRouteTarget = {
  kind: "server",
  threadRef: scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("thread-a")),
};
const paneTarget: ThreadRouteTarget = { kind: "draft", draftId: DraftId.make("draft-b") };

describe("resolveNewThreadSourceTarget", () => {
  it("uses an explicit pane target instead of the current URL", () => {
    expect(resolveNewThreadSourceTarget(routeTarget, paneTarget)).toBe(paneTarget);
  });

  it("retains route behavior for callers outside the pane workspace", () => {
    expect(resolveNewThreadSourceTarget(routeTarget, undefined)).toBe(routeTarget);
    expect(resolveNewThreadSourceTarget(routeTarget, null)).toBeNull();
  });
});
