import { createFileRoute } from "@tanstack/react-router";

// Draft promotion is pane-local in ChatPaneWorkspace so background drafts do
// not hijack the focused pane's URL.
export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: () => null,
});
