import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { PublicKey } from "@solana/web3.js";

export const SCALAR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface NativeProofManifest {
  readonly generation: "request-bound-v1";
  readonly deploymentDomain: string;
  readonly genesisHash: string;
  readonly verifierProgram: string;
  readonly consumerProgram: string;
  readonly zkey: Readonly<{ uri: string; sha256: string }>;
}

export interface NativeProofAction {
  readonly identity: string;
  readonly mint: string;
  readonly counter: bigint;
  readonly projectionVersion: number;
  readonly commitmentNew: string;
  readonly commitmentPrevious: string;
  readonly threshold: number;
  readonly minDistance: number;
  readonly validUntil: bigint;
}

export interface PreparedNativeProofRequest {
  readonly manifest: NativeProofManifest;
  readonly wallet: string;
  readonly nonce: string;
  readonly action: NativeProofAction;
  readonly digest: string;
  readonly digestHi: string;
  readonly digestLo: string;
}

export function hex32(value: string): Uint8Array {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Expected 32 bytes encoded as lowercase hexadecimal.");
  }
  return hexToBytes(value);
}

function publicKey(value: string): Uint8Array {
  const key = new PublicKey(value);
  if (key.toBase58() !== value) throw new Error("Noncanonical public key.");
  return key.toBytes();
}

function unsigned(value: bigint, length: number): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(length * 8)) {
    throw new Error("Unsigned integer is outside its encoded range.");
  }
  const result = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    result[i] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  return result;
}

function smallInteger(value: number, maximum: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error("Integer is outside its permitted range.");
  }
  return unsigned(BigInt(value), 2);
}

export function canonicalScalar(value: string): Uint8Array {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Expected a canonical decimal scalar.");
  }
  const scalar = BigInt(value);
  if (scalar >= SCALAR_MODULUS) throw new Error("Scalar is outside the proof field.");
  return unsigned(scalar, 32);
}

function commitment(value: string): Uint8Array {
  const bytes = hex32(value);
  const scalar = BigInt(`0x${value}`);
  if (scalar === 0n || scalar >= SCALAR_MODULUS) {
    throw new Error("Commitment is outside the proof field.");
  }
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function domain(text: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

export function validateNativeProofManifest(manifest: NativeProofManifest): NativeProofManifest {
  if (manifest.generation !== "request-bound-v1") throw new Error("Unsupported proof generation.");
  hex32(manifest.deploymentDomain);
  publicKey(manifest.verifierProgram);
  publicKey(manifest.consumerProgram);
  publicKey(manifest.genesisHash);
  hex32(manifest.zkey.sha256);
  if (!/^(https:\/\/|file:\/\/)/.test(manifest.zkey.uri)) {
    throw new Error("The proving artifact requires an HTTPS or local file URI.");
  }
  return Object.freeze({ ...manifest, zkey: Object.freeze({ ...manifest.zkey }) });
}

export function parseNativeProofManifest(
  encoded: string | undefined,
): NativeProofManifest | undefined {
  if (!encoded) return undefined;
  const value: unknown = JSON.parse(encoded);
  if (typeof value !== "object" || value === null) throw new Error("Invalid proof manifest.");
  const record = value as Record<string, unknown>;
  const zkey = record.zkey;
  if (typeof zkey !== "object" || zkey === null)
    throw new Error("Invalid proving artifact manifest.");
  const artifact = zkey as Record<string, unknown>;
  const stringField = (entry: Record<string, unknown>, name: string): string => {
    const field = entry[name];
    if (typeof field !== "string") throw new Error(`Invalid proof manifest field: ${name}.`);
    return field;
  };
  if (record.generation !== "request-bound-v1") throw new Error("Unsupported proof generation.");
  return validateNativeProofManifest({
    generation: record.generation,
    deploymentDomain: stringField(record, "deploymentDomain"),
    genesisHash: stringField(record, "genesisHash"),
    verifierProgram: stringField(record, "verifierProgram"),
    consumerProgram: stringField(record, "consumerProgram"),
    zkey: { uri: stringField(artifact, "uri"), sha256: stringField(artifact, "sha256") },
  });
}

export function encodeNativeProofAction(action: NativeProofAction): Uint8Array {
  if (action.validUntil <= 0n) throw new Error("The proof request expiry must be positive.");
  if (action.minDistance > action.threshold) throw new Error("Invalid Hamming bounds.");
  return concat([
    domain("ENTROS_ANCHOR_UPDATE_V1"),
    publicKey(action.identity),
    publicKey(action.mint),
    unsigned(action.counter, 8),
    smallInteger(action.projectionVersion, 65535),
    commitment(action.commitmentNew),
    commitment(action.commitmentPrevious),
    smallInteger(action.threshold, 256),
    smallInteger(action.minDistance, 256),
    unsigned(action.validUntil, 8),
  ]);
}

export function prepareNativeProofRequest(
  manifest: NativeProofManifest,
  wallet: string,
  nonce: string,
  action: NativeProofAction,
): PreparedNativeProofRequest {
  const checkedManifest = validateNativeProofManifest(manifest);
  const nonceBytes = hex32(nonce);
  if (nonceBytes.every((byte) => byte === 0)) throw new Error("The proof nonce must be nonzero.");
  const request = concat([
    domain("ENTROS_PROOF_REQUEST_V1"),
    hex32(checkedManifest.deploymentDomain),
    publicKey(checkedManifest.verifierProgram),
    publicKey(checkedManifest.consumerProgram),
    publicKey(wallet),
    nonceBytes,
    new Uint8Array([1]),
    sha256(encodeNativeProofAction(action)),
  ]);
  const digest = sha256(request);
  return Object.freeze({
    manifest: checkedManifest,
    wallet,
    nonce,
    action: Object.freeze({ ...action }),
    digest: bytesToHex(digest),
    digestHi: BigInt(`0x${bytesToHex(digest.subarray(0, 16))}`).toString(),
    digestLo: BigInt(`0x${bytesToHex(digest.subarray(16))}`).toString(),
  });
}

export function validatePreparedNativeProofRequest(
  request: PreparedNativeProofRequest,
): PreparedNativeProofRequest {
  const expected = prepareNativeProofRequest(
    request.manifest,
    request.wallet,
    request.nonce,
    request.action,
  );
  if (
    expected.digest !== request.digest ||
    expected.digestHi !== request.digestHi ||
    expected.digestLo !== request.digestLo
  ) {
    throw new Error("The prepared proof request has changed.");
  }
  return expected;
}

export function expectedNativePublicSignals(request: PreparedNativeProofRequest): string[] {
  const checked = validatePreparedNativeProofRequest(request);
  return [
    BigInt(`0x${checked.action.commitmentNew}`).toString(),
    BigInt(`0x${checked.action.commitmentPrevious}`).toString(),
    checked.action.threshold.toString(),
    checked.action.minDistance.toString(),
    checked.digestHi,
    checked.digestLo,
  ];
}
