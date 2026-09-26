// Starts a single capture: fetches the server challenge the capture binds and
// holds it for the capture and processing screens.

import { devWarn } from "@/lib/log";
import { fetchChallenge } from "@/services/executor";
import { setChallenge } from "@/state/challengeBuffer";

/** Throws when the executor cannot issue a challenge. */
export async function holdSingleCaptureChallenge(
  wallet: string,
  projectionVersion: number,
): Promise<void> {
  const challenge = await fetchChallenge(wallet);
  setChallenge({
    nonce: challenge.nonce,
    phrase: challenge.phrase,
    expiresIn: challenge.expiresIn,
    expiresAtMs: challenge.expiresAtMs,
    curve: challenge.curve,
    projectionVersion,
  });
  devWarn(`[Entros] /challenge ok ttl=${challenge.expiresIn}s`);
}
