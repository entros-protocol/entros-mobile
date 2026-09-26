// Play Integrity tokens for paired sessions on Android.
//
// A token binds the attestation digest through its requestHash. The validator
// verifies it and signs an assurance tier into the receipt. A verified token
// is stronger app and device integrity evidence bound to this request. It does
// not prove a person, a microphone or a touchscreen, and it carries no device
// identifier.
//
// Attestation never blocks or fails a verification. Every path here resolves
// to a token or to null, and a verification without a token proceeds at the
// open tier.

import { config } from "@/config";
import { devWarn } from "@/lib/log";

import { EntrosPlayIntegrity } from "../../modules/entros-play-integrity";

const DEFAULT_TOKEN_TIMEOUT_MS = 4_000;
const REQUEST_HASH_HEX = /^[0-9a-f]{64}$/;

/** Prepares the token provider early, so a finalize does not wait for it. */
export function warm(): void {
  const native = EntrosPlayIntegrity;
  const projectNumber = config.playIntegrityCloudProjectNumber;
  if (!native || projectNumber === null) return;
  try {
    native.prepare(projectNumber).catch((error: unknown) => {
      devWarn(`[Entros] Play Integrity prepare failed: ${describe(error)}`);
    });
  } catch (error) {
    devWarn(`[Entros] Play Integrity prepare failed: ${describe(error)}`);
  }
}

/**
 * A standard integrity token whose requestHash is `requestHashHex`, the
 * lowercase hex of the attestation digest. Resolves null when the module or
 * the project number is absent, when Play fails, or after `timeoutMs`. Never
 * throws.
 */
export async function tokenFor(
  requestHashHex: string,
  timeoutMs = DEFAULT_TOKEN_TIMEOUT_MS,
): Promise<string | null> {
  const native = EntrosPlayIntegrity;
  const projectNumber = config.playIntegrityCloudProjectNumber;
  if (!native || projectNumber === null || !REQUEST_HASH_HEX.test(requestHashHex)) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const requested = (async (): Promise<string | null> => {
    await native.prepare(projectNumber);
    const token = await native.request(requestHashHex);
    return typeof token === "string" && token.length > 0 ? token : null;
  })().catch((error: unknown) => {
    devWarn(`[Entros] Play Integrity token unavailable: ${describe(error)}`);
    return null;
  });
  try {
    return await Promise.race([requested, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
