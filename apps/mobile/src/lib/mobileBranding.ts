export type MobileStageLabel = "Alpha" | "Dev" | "Nightly";

export const MOBILE_PRODUCT_NAME = "T3 Turbo";
export const MOBILE_CLIENT_LABEL = `${MOBILE_PRODUCT_NAME} Mobile`;

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Alpha";
}
