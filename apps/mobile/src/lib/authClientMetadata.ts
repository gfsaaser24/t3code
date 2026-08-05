import type { AuthClientPresentationMetadata } from "@t3tools/contracts";

import { MOBILE_CLIENT_LABEL } from "./mobileBranding";
import { Platform } from "react-native";

export function authClientMetadata(): AuthClientPresentationMetadata {
  return {
    label: MOBILE_CLIENT_LABEL,
    deviceType: "mobile",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
  };
}
