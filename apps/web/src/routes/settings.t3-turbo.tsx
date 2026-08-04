import { createFileRoute } from "@tanstack/react-router";

import { T3TurboSettingsPanel } from "../components/settings/T3TurboSettings";

function SettingsT3TurboRoute() {
  return <T3TurboSettingsPanel />;
}

export const Route = createFileRoute("/settings/t3-turbo")({
  component: SettingsT3TurboRoute,
});
