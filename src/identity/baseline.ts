// Encrypted baseline persistence for re-verification.
//
// Stores the {fingerprint, salt, commitment, timestamp} bundle as an
// AES-256-GCM ciphertext envelope in expo-secure-store. The AES key lives
// in the same secure-store namespace, hardware-backed at rest by the OS
// (Android Keystore / iOS Keychain). Re-verification decrypts the prior
// fingerprint only while generating the Hamming distance proof.
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
//
// Each wallet on each cluster has its own envelope and key, so a second
// wallet on the same phone never replaces the first wallet's baseline.

import { gcm } from "@noble/ciphers/aes.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";

import { bigintToBytes32 } from "@/hashing";
import { devWarn } from "@/lib/log";
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
 * - `fingerprint`: 256 SimHash bits stored as a 0/1 array.
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

/** The wallet and cluster a baseline belongs to. */
export interface BaselineScope {
  cluster: string;
  wallet: string;
}

export interface PreparedBaseline {
  scope: BaselineScope;
  serializedEnvelope: string;
}

interface EntryKeys {
  envelope: string;
  key: string;
  /**
   * Set by a reset of a wallet's baseline, cleared when the wallet stores a
   * new one. Holds the lowercase hex of the chain commitment at the reset, or
   * "*" when it was unknown. Only a wallet's own entry has one.
   */
  erased?: string;
}

const ERASED_ANY = "*";

const LEGACY_ENTRY: EntryKeys = {
  envelope: SecureKeys.LEGACY_BASELINE_ENVELOPE,
  key: SecureKeys.LEGACY_BASELINE_KEY,
};

// Secure-store keys accept letters, digits, ".", "-" and "_" alone.
const CLUSTER_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const entryFor = (scope: BaselineScope): EntryKeys => {
  if (!CLUSTER_PATTERN.test(scope.cluster) || !WALLET_PATTERN.test(scope.wallet)) {
    throw new Error("A baseline scope needs a cluster name and a base58 wallet address.");
  }
  const prefix = `baseline.${scope.cluster}.${scope.wallet}`;
  return { envelope: `${prefix}.envelope`, key: `${prefix}.key`, erased: `${prefix}.erased` };
};

export interface PrepareBaselineOptions {
  /**
   * Treat a key entry the store cannot read as absent and write a new key.
   * Only for a caller that needs nothing from the stored envelope: the new key
   * replaces the old one at once, while the envelope it opens stays until
   * {@link persistPreparedBaseline} runs.
   */
  replaceUnreadableKey?: boolean;
}

const getOrCreateAesKey = async (
  entry: EntryKeys,
  replaceUnreadableKey: boolean,
): Promise<Uint8Array> => {
  let existing: string | null;
  try {
    existing = await getSecure(entry.key);
  } catch (err) {
    if (!replaceUnreadableKey) throw err;
    // An entry that cannot be read can open nothing.
    existing = null;
  }
  if (existing) return hexToBytes(existing);
  const key = randomBytes(AES_KEY_BYTES);
  await setSecure(entry.key, bytesToHex(key));
  return key;
};

/**
 * Encrypt a baseline for one wallet and cluster. Nothing replaces the stored
 * envelope until {@link persistPreparedBaseline} runs. Throws on secure-store
 * I/O failure or on a scope that cannot name a secure-store entry. A key that
 * reads back is always reused.
 */
export const prepareBaseline = async (
  scope: BaselineScope,
  baseline: StoredBaseline,
  { replaceUnreadableKey = false }: PrepareBaselineOptions = {},
): Promise<PreparedBaseline> => {
  const key = await getOrCreateAesKey(entryFor(scope), replaceUnreadableKey);
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(baseline));
  const ct = gcm(key, iv).encrypt(plaintext);
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    iv: bytesToHex(iv),
    ct: bytesToHex(ct),
  };
  return { scope: { ...scope }, serializedEnvelope: JSON.stringify(envelope) };
};

export const persistPreparedBaseline = async (prepared: PreparedBaseline): Promise<void> => {
  const entry = entryFor(prepared.scope);
  await setSecure(entry.envelope, prepared.serializedEnvelope);
  if (!entry.erased) return;
  try {
    await deleteSecure(entry.erased);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    devWarn(`[Entros] baseline reset marker kept: ${message}`);
  }
};

export const storeBaseline = async (
  scope: BaselineScope,
  baseline: StoredBaseline,
): Promise<void> => {
  await persistPreparedBaseline(await prepareBaseline(scope, baseline));
};

interface ReadEntry {
  baseline: StoredBaseline;
  serializedEnvelope: string;
  keyHex: string;
}

/** Decrypts one entry. Null when it is absent, malformed or does not decrypt. */
const readEntry = async (entry: EntryKeys): Promise<ReadEntry | null> => {
  const raw = await getSecure(entry.envelope);
  if (!raw) return null;

  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    return null;
  }
  if (envelope.v !== ENVELOPE_VERSION) return null;

  const keyHex = await getSecure(entry.key);
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
      baseline: {
        fingerprint: decoded.fingerprint,
        salt: decoded.salt,
        commitment: decoded.commitment,
        timestamp: decoded.timestamp,
        projectionVersion:
          typeof decoded.projectionVersion === "number" ? decoded.projectionVersion : 0,
      },
      serializedEnvelope: raw,
      keyHex,
    };
  } catch {
    return null;
  }
};

const DECIMAL = /^[0-9]{1,78}$/;

/** Whether the stored commitment equals the 32-byte big-endian chain value. */
const matchesChain = (baseline: StoredBaseline, chainCommitment: Uint8Array): boolean => {
  if (!DECIMAL.test(baseline.commitment) || chainCommitment.length !== 32) return false;
  const value = BigInt(baseline.commitment);
  if (value >> BigInt(256) !== BigInt(0)) return false;
  const stored = bigintToBytes32(value);
  return stored.every((byte, index) => byte === chainCommitment[index]);
};

/**
 * Copies `read` from one entry to another, then deletes the source. The new
 * key and envelope are written before anything is deleted, so a failure never
 * leaves the baseline without a copy. A failed write keeps the source, and a
 * failed delete leaves a stale source that no later load matches.
 */
const moveEntry = async (to: EntryKeys, from: EntryKeys, read: ReadEntry): Promise<void> => {
  try {
    await setSecure(to.key, read.keyHex);
    await setSecure(to.envelope, read.serializedEnvelope);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    devWarn(`[Entros] baseline move failed: ${message}`);
    return;
  }
  try {
    await Promise.all([deleteSecure(from.envelope), deleteSecure(from.key)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    devWarn(`[Entros] baseline move left its source: ${message}`);
  }
};

/** Deletes an entry a reset already erased in intent. A failed delete is logged. */
const discardEntry = async (entry: EntryKeys, read: ReadEntry): Promise<void> => {
  read.baseline.fingerprint.fill(0);
  try {
    await Promise.all([deleteSecure(entry.envelope), deleteSecure(entry.key)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    devWarn(`[Entros] erased baseline delete failed: ${message}`);
  }
};

/** Whether a reset of `entry` covers `chainCommitment`. */
const erasedFor = async (entry: EntryKeys, chainCommitment: Uint8Array): Promise<boolean> => {
  if (!entry.erased) return false;
  const marker = await getSecure(entry.erased);
  return marker === ERASED_ANY || marker === bytesToHex(chainCommitment);
};

/**
 * Loads the baseline for one wallet and cluster when its commitment equals
 * the wallet's on-chain commitment. When the wallet's own entry is absent or
 * stale, the wallet takes the unscoped entry an earlier build wrote, when that
 * entry matches its chain commitment. An unscoped entry that matches no
 * wallet stays in place.
 *
 * `previousWallet` names the wallet the identity migrated from, when the
 * chain records one. With no matching own or unscoped entry, that wallet's
 * entry on the same cluster moves to this wallet when it matches the chain
 * commitment. One hop only: the earlier wallet's own history is not followed.
 *
 * After a reset of this wallet's baseline, the wallet adopts nothing until it
 * stores a new baseline. A matching entry found then is the one the reset was
 * meant to erase, so it is deleted.
 *
 * Returns null when no matching entry exists, or when the entry is
 * malformed, has an unknown version, lacks its key, or fails to decrypt.
 * The verify flow then routes the wallet to the baseline-missing screen.
 */
export const loadBaseline = async (
  scope: BaselineScope,
  chainCommitment: Uint8Array,
  previousWallet?: string | null,
): Promise<StoredBaseline | null> => {
  const entry = entryFor(scope);
  const own = await readEntry(entry);
  if (own) {
    if (matchesChain(own.baseline, chainCommitment)) return own.baseline;
    // A stale own entry stays unless a matching entry below replaces it.
    own.baseline.fingerprint.fill(0);
  }
  const erased = await erasedFor(entry, chainCommitment);

  const legacy = await readEntry(LEGACY_ENTRY);
  if (legacy && matchesChain(legacy.baseline, chainCommitment)) {
    if (!erased) {
      await moveEntry(entry, LEGACY_ENTRY, legacy);
      return legacy.baseline;
    }
    await discardEntry(LEGACY_ENTRY, legacy);
  }
  legacy?.baseline.fingerprint.fill(0);

  if (!previousWallet || previousWallet === scope.wallet) return null;
  const previousEntry = entryFor({ cluster: scope.cluster, wallet: previousWallet });
  const previous = await readEntry(previousEntry);
  if (!previous) return null;
  if (!matchesChain(previous.baseline, chainCommitment)) {
    previous.baseline.fingerprint.fill(0);
    return null;
  }
  if (erased) {
    await discardEntry(previousEntry, previous);
    return null;
  }
  await moveEntry(entry, previousEntry, previous);
  return previous.baseline;
};

/**
 * Erases the baseline the person asked to erase: the envelope and key of
 * `scope`. The unscoped entry an earlier build wrote may belong to another
 * wallet, so with a wallet connected it goes now only when it decrypts and
 * its commitment equals `chainCommitment`, the wallet's commitment on chain.
 * An unknown commitment or a mismatch leaves it for the wallet it belongs to.
 * The wallet also gets a reset marker, so the next load adopts no other entry
 * for that commitment and deletes any it finds. With no wallet connected,
 * `scope` is null and the unscoped entry is all there is to name, so it goes.
 *
 * A partial failure leaves orphan state that loadBaseline tolerates (returns
 * null), so the next cycle still routes to a fresh baseline.
 */
export const wipeBaseline = async (
  scope: BaselineScope | null,
  chainCommitment: Uint8Array | null = null,
): Promise<void> => {
  const entry = scope ? entryFor(scope) : null;
  let wipeLegacy = entry === null;
  if (entry && chainCommitment) {
    // An unreadable unscoped entry cannot be matched, so it stays and the
    // wallet's own entry is still erased.
    const legacy = await readEntry(LEGACY_ENTRY).catch(() => null);
    wipeLegacy = legacy !== null && matchesChain(legacy.baseline, chainCommitment);
    legacy?.baseline.fingerprint.fill(0);
  }
  await Promise.all([
    ...(entry ? [deleteSecure(entry.envelope), deleteSecure(entry.key)] : []),
    // Another entry that matches this wallet's chain may still be on the
    // phone, under the wallet the identity migrated from or unscoped. The
    // marker keeps the next load from adopting it.
    ...(entry?.erased
      ? [setSecure(entry.erased, chainCommitment ? bytesToHex(chainCommitment) : ERASED_ANY)]
      : []),
    ...(wipeLegacy ? [deleteSecure(LEGACY_ENTRY.envelope), deleteSecure(LEGACY_ENTRY.key)] : []),
  ]);
};
