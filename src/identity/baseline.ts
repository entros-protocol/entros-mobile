// Encrypted baseline persistence for re-verification.
//
// Stores the {fingerprint, salt, commitment, timestamp} bundle as an
// AES-256-GCM ciphertext envelope in expo-secure-store. The AES key lives
// in the same secure-store namespace, hardware-backed at rest by the OS
// (Android Keystore / iOS Keychain). On future verify cycles, Stage 6 will
// decrypt to recover the prior fingerprint for the Hamming distance proof.
//
// Mirrors pulse-sdk/src/identity/{anchor,crypto}.ts envelope semantics so a
// future migration tool could read either format. Plaintext shape matches
// pulse-sdk/src/identity/types.ts:StoredVerificationData byte-for-byte.
//
// PRIVACY:
// - The fingerprint is the most sensitive value in the verification flow.
//   It is held unencrypted in caller memory only for the duration of the
//   IIFE in processing.tsx (simhash → generateTBH → storeBaseline). After
//   storeBaseline returns, only the AES ciphertext exists on the device.
// - The AES key bytes are recoverable to in-app JS but not to other apps
//   (sandbox isolation) and not to off-device disk attacks (Keystore /
//   Keychain encrypt at rest). This matches the threat model the wallet
//   auth token already operates under.
// - JSON.stringify of the plaintext is a transient string; GC reclaims it
//   after the encrypt call returns.

import { gcm } from "@noble/ciphers/aes.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";

import { deleteSecure, getSecure, SecureKeys, setSecure } from "@/storage/secure";

const ENVELOPE_VERSION = 1;
const AES_KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard

interface Envelope {
  v: 1;
  iv: string; // hex
  ct: string; // hex
}

/**
 * Plaintext baseline shape. Matches pulse-sdk/src/identity/types.ts:
 * StoredVerificationData byte-for-byte so a future migration could read
 * either platform's envelope.
 *
 * - `fingerprint`: 256 bits as 0/1 array (Stage 3 simhash output).
 * - `salt`: bigint serialised as decimal string (matches web SDK).
 * - `commitment`: bigint serialised as decimal string (matches web SDK).
 * - `timestamp`: epoch milliseconds at the moment of persistence.
 */
export interface StoredBaseline {
  fingerprint: number[];
  salt: string;
  commitment: string;
  timestamp: number;
  projectionVersion: number;
}

export interface PreparedBaseline {
  serializedEnvelope: string;
}

const getOrCreateAesKey = async (): Promise<Uint8Array> => {
  const existing = await getSecure(SecureKeys.BASELINE_KEY);
  if (existing) return hexToBytes(existing);
  const key = randomBytes(AES_KEY_BYTES);
  await setSecure(SecureKeys.BASELINE_KEY, bytesToHex(key));
  return key;
};

/**
 * Encrypt and persist a baseline. Replaces any prior envelope under the
 * same secure-store key. Throws on secure-store I/O failure (caller decides
 * whether to fail the verify flow or log + continue).
 */
export const prepareBaseline = async (baseline: StoredBaseline): Promise<PreparedBaseline> => {
  const key = await getOrCreateAesKey();
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(baseline));
  const ct = gcm(key, iv).encrypt(plaintext);
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    iv: bytesToHex(iv),
    ct: bytesToHex(ct),
  };
  return { serializedEnvelope: JSON.stringify(envelope) };
};

export const persistPreparedBaseline = async (prepared: PreparedBaseline): Promise<void> => {
  await setSecure(SecureKeys.BASELINE_ENVELOPE, prepared.serializedEnvelope);
};

export const storeBaseline = async (baseline: StoredBaseline): Promise<void> => {
  await persistPreparedBaseline(await prepareBaseline(baseline));
};

/**
 * Load and decrypt the persisted baseline. Returns null when:
 * - No envelope is stored (first-time user).
 * - Envelope JSON is malformed (corrupt secure-store value).
 * - Envelope version is unrecognised (forward-compat downgrade).
 * - AES key is missing despite envelope being present (mismatched wipe).
 * - Decryption fails (key/IV/ciphertext mismatch — treat as corrupt).
 *
 * In every null case, the verify flow treats the user as first-time and
 * mints a fresh anchor on the next cycle.
 */
export const loadBaseline = async (): Promise<StoredBaseline | null> => {
  const raw = await getSecure(SecureKeys.BASELINE_ENVELOPE);
  if (!raw) return null;

  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    return null;
  }
  if (envelope.v !== ENVELOPE_VERSION) return null;

  const keyHex = await getSecure(SecureKeys.BASELINE_KEY);
  if (!keyHex) return null;

  try {
    const plaintext = gcm(hexToBytes(keyHex), hexToBytes(envelope.iv)).decrypt(
      hexToBytes(envelope.ct),
    );
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<StoredBaseline>;
    if (
      !Array.isArray(decoded.fingerprint) ||
      typeof decoded.salt !== "string" ||
      typeof decoded.commitment !== "string" ||
      typeof decoded.timestamp !== "number"
    ) {
      return null;
    }
    return {
      fingerprint: decoded.fingerprint,
      salt: decoded.salt,
      commitment: decoded.commitment,
      timestamp: decoded.timestamp,
      projectionVersion:
        typeof decoded.projectionVersion === "number" ? decoded.projectionVersion : 0,
    };
  } catch {
    return null;
  }
};

/**
 * Wipe both the envelope and the AES key. Called on `reset_identity_state`
 * confirmation (Stage 7 will route an on-chain reset here; Stage 5 wires
 * the dev-panel reset action through the same path).
 *
 * Both deletes run in parallel. A partial failure leaves orphan state that
 * loadBaseline tolerates (returns null), so the next cycle still mints a
 * fresh anchor cleanly.
 */
export const wipeBaseline = async (): Promise<void> => {
  await Promise.all([
    deleteSecure(SecureKeys.BASELINE_ENVELOPE),
    deleteSecure(SecureKeys.BASELINE_KEY),
  ]);
};
