import { sha256 } from "@noble/hashes/sha2";
import * as Encoding from "effect/Encoding";

// T3 Turbo: the base64url SHA-256 of a string, written once.
//
// This expression is the DPoP thumbprint, the DPoP access-token hash, and the relay's token-memo
// key. All three had their own inline copy, each allocating its own `TextEncoder` per call on a
// per-request path. The encoder is hoisted to module scope here because `TextEncoder` is
// stateless -- `encode` returns a fresh array every call -- so one instance is safe to share.
const encoder = new TextEncoder();

export function sha256Base64Url(text: string): string {
  return Encoding.encodeBase64Url(sha256(encoder.encode(text)));
}
