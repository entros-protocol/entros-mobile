// Play Integrity standard requests for the Android build. Resolves to null
// where the native module is absent: iOS, the web, and Jest.

import { requireOptionalNativeModule } from "expo";

export interface EntrosPlayIntegrityModule {
  /** Prepares a token provider for a Google Cloud project. Safe to call again. */
  prepare(cloudProjectNumber: number): Promise<void>;
  /** A standard integrity token whose requestHash is `requestHashHex`. */
  request(requestHashHex: string): Promise<string>;
}

export const EntrosPlayIntegrity =
  requireOptionalNativeModule<EntrosPlayIntegrityModule>("EntrosPlayIntegrity");
