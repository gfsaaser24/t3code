import { createFileRoute } from "@tanstack/react-router";

// The stable workspace is owned by the parent chat route. This leaf keeps the
// canonical focused-pane URL without remounting every open chat on navigation.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: () => null,
});
