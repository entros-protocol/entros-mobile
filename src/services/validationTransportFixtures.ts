import { sha256 } from "@noble/hashes/sha2.js";

import {
  buildValidateFeaturesRequestBody,
  type ValidateFeaturesRequestBody,
} from "./validationRequest";
import { buildValidationRequestDigest, bytesToHex } from "./validationAuthorization";

const SAMPLE_RATE_HZ = 16_000;
const FEATURE_COUNT = 308;
const CONTOUR_INTERVAL_MS = 10;
const OUTLINE_POINT_COUNT = 64;
const BINARY_ENVELOPE_HEADER_BYTES = 16;
const BINARY_ENVELOPE_MAGIC = Uint8Array.of(0x45, 0x4e, 0x54, 0x56);
const EXECUTOR_BODY_LIMIT_BYTES = 1_048_576;
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const VALIDATION_BINARY_ENVELOPE_VERSION = 1;
export const VALIDATION_BINARY_ENVELOPE_FLAGS = 1;

export const VALIDATION_TRANSPORT_PROFILES = [
  { name: "projection-1-mobile-maximum", projectionVersion: 1, durationMs: 12_000 },
  { name: "projection-1-service-ceiling", projectionVersion: 1, durationMs: 20_000 },
  { name: "projection-2-mobile-maximum", projectionVersion: 2, durationMs: 12_000 },
  { name: "projection-2-service-ceiling", projectionVersion: 2, durationMs: 20_000 },
] as const;

export type ValidationTransportProfile = (typeof VALIDATION_TRANSPORT_PROFILES)[number];
export type ValidationTransportProfileName = ValidationTransportProfile["name"];

export interface SyntheticValidationTransportFixture {
  profile: ValidationTransportProfile;
  request: ValidateFeaturesRequestBody;
  pcm16Bytes: Uint8Array;
  json: string;
  binaryEnvelope: Uint8Array;
  jsonBytes: number;
  binaryBytes: number;
  base64Bytes: number;
  decodedPcmBytes: number;
  pcmSha256Hex: string;
  authorizationDigestHex: string;
  jsonSha256Hex: string;
  binarySha256Hex: string;
}

function generatePcm16(durationMs: number): Uint8Array {
  const sampleCount = (durationMs * SAMPLE_RATE_HZ) / 1_000;
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = ((index * 1_103 + 7_919) & 0xffff) - 32_768;
    view.setInt16(index * 2, sample, true);
  }

  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!STANDARD_BASE64.test(value)) {
    throw new Error("Binary envelope requires canonical base64 PCM");
  }
  const binary = atob(value);
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64(decoded) !== value) {
    throw new Error("Binary envelope requires canonical base64 PCM");
  }
  return decoded;
}

export function encodeValidationBinaryEnvelope(request: ValidateFeaturesRequestBody): Uint8Array {
  const { audio_samples_b64: audioSamplesB64, ...metadata } = request;
  if (typeof audioSamplesB64 !== "string") {
    throw new Error("Binary envelope requires PCM");
  }

  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const pcmBytes = decodeCanonicalBase64(audioSamplesB64);
  if (pcmBytes.byteLength === 0 || pcmBytes.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Binary envelope requires non-empty PCM16");
  }
  const envelopeLength =
    BINARY_ENVELOPE_HEADER_BYTES + metadataBytes.byteLength + pcmBytes.byteLength;
  if (envelopeLength > EXECUTOR_BODY_LIMIT_BYTES) {
    throw new Error("Binary envelope exceeds executor body limit");
  }
  const envelope = new Uint8Array(envelopeLength);
  const header = new DataView(envelope.buffer, envelope.byteOffset, BINARY_ENVELOPE_HEADER_BYTES);
  envelope.set(BINARY_ENVELOPE_MAGIC, 0);
  header.setUint16(4, VALIDATION_BINARY_ENVELOPE_VERSION, true);
  header.setUint16(6, VALIDATION_BINARY_ENVELOPE_FLAGS, true);
  header.setUint32(8, metadataBytes.byteLength, true);
  header.setUint32(12, pcmBytes.byteLength, true);
  envelope.set(metadataBytes, BINARY_ENVELOPE_HEADER_BYTES);
  envelope.set(pcmBytes, BINARY_ENVELOPE_HEADER_BYTES + metadataBytes.byteLength);
  return envelope;
}

export function decodeValidationBinaryEnvelope(envelope: Uint8Array): ValidateFeaturesRequestBody {
  if (envelope.byteLength > EXECUTOR_BODY_LIMIT_BYTES) {
    throw new Error("Binary envelope exceeds executor body limit");
  }
  if (envelope.byteLength < BINARY_ENVELOPE_HEADER_BYTES) {
    throw new Error("Truncated binary envelope header");
  }
  if (BINARY_ENVELOPE_MAGIC.some((byte, index) => envelope[index] !== byte)) {
    throw new Error("Invalid binary envelope magic");
  }

  const header = new DataView(envelope.buffer, envelope.byteOffset, BINARY_ENVELOPE_HEADER_BYTES);
  const version = header.getUint16(4, true);
  if (version !== VALIDATION_BINARY_ENVELOPE_VERSION) {
    throw new Error(`Unsupported binary envelope version ${version}`);
  }
  const flags = header.getUint16(6, true);
  if (flags !== VALIDATION_BINARY_ENVELOPE_FLAGS) {
    throw new Error("Invalid binary envelope flags");
  }

  const metadataLength = header.getUint32(8, true);
  const pcmLength = header.getUint32(12, true);
  if (pcmLength === 0 || pcmLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Invalid binary envelope PCM length");
  }
  const expectedLength = BINARY_ENVELOPE_HEADER_BYTES + metadataLength + pcmLength;
  if (envelope.byteLength < expectedLength) {
    throw new Error("Truncated binary envelope body");
  }
  if (envelope.byteLength > expectedLength) {
    throw new Error("Trailing binary envelope bytes");
  }

  const metadataEnd = BINARY_ENVELOPE_HEADER_BYTES + metadataLength;
  let metadata: unknown;
  try {
    const metadataJson = new TextDecoder("utf-8", { fatal: true }).decode(
      envelope.subarray(BINARY_ENVELOPE_HEADER_BYTES, metadataEnd),
    );
    metadata = JSON.parse(metadataJson) as unknown;
  } catch {
    throw new Error("Invalid binary envelope metadata");
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Invalid binary envelope metadata");
  }
  const record = metadata as Record<string, unknown>;
  if (
    !Array.isArray(record.features) ||
    record.features.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
    typeof record.wallet_id !== "string"
  ) {
    throw new Error("Invalid binary envelope metadata");
  }
  if (Object.prototype.hasOwnProperty.call(metadata, "audio_samples_b64")) {
    throw new Error("Binary envelope metadata duplicates PCM");
  }

  return {
    ...metadata,
    audio_samples_b64: encodeBase64(envelope.subarray(metadataEnd)),
  } as ValidateFeaturesRequestBody;
}

function primaryFeatures(): number[] {
  return Array.from({ length: FEATURE_COUNT }, (_, index) => (index - 154) / 16);
}

function compatibilityFeatures(): number[] {
  return Array.from({ length: FEATURE_COUNT }, (_, index) => (index - 154) / 32);
}

function f0Contour(durationMs: number): number[] {
  return Array.from(
    { length: durationMs / CONTOUR_INTERVAL_MS },
    (_, index) => 80 + (index % 37) / 2,
  );
}

function accelerationContour(durationMs: number): number[] {
  return Array.from(
    { length: durationMs / CONTOUR_INTERVAL_MS },
    (_, index) => ((index % 29) - 14) / 64,
  );
}

function coarseOutline(): [number, number][] {
  return Array.from({ length: OUTLINE_POINT_COUNT }, (_, index) => [
    (index * 100) / (OUTLINE_POINT_COUNT - 1),
    (((index * 17) % OUTLINE_POINT_COUNT) * 100) / (OUTLINE_POINT_COUNT - 1),
  ]);
}

function requestForProfile(
  profile: ValidationTransportProfile,
  audioSamplesB64: string,
): ValidateFeaturesRequestBody {
  const request = buildValidateFeaturesRequestBody({
    features: primaryFeatures(),
    projectionVersion: profile.projectionVersion,
    walletId: "11111111111111111111111111111111",
    f0Contour: f0Contour(profile.durationMs),
    accelMagnitude: accelerationContour(profile.durationMs),
    audioSamplesB64,
    audioSampleRateHz: SAMPLE_RATE_HZ,
    commitmentNewHex: "11".repeat(32),
    receiptPurpose: "mint",
    compatibilityEvidence:
      profile.projectionVersion === 2
        ? {
            projection_version: 1,
            feature_schema_version: 4,
            features: compatibilityFeatures(),
          }
        : undefined,
    curveTrace: {
      points: coarseOutline(),
      duration_ms: profile.durationMs,
    },
  });

  if (profile.projectionVersion === 2) {
    request.wallet_authorization = {
      nonce: Array.from({ length: 32 }, () => 0x5a),
      signature_hex: "ab".repeat(64),
    };
  }

  return JSON.parse(JSON.stringify(request)) as ValidateFeaturesRequestBody;
}

export function buildSyntheticValidationTransportFixture(
  profileName: ValidationTransportProfileName,
): SyntheticValidationTransportFixture {
  const profile = VALIDATION_TRANSPORT_PROFILES.find(({ name }) => name === profileName);
  if (!profile) {
    throw new Error(`Unknown validation transport profile: ${profileName}`);
  }

  const pcm16Bytes = generatePcm16(profile.durationMs);
  const audioSamplesB64 = encodeBase64(pcm16Bytes);
  const request = requestForProfile(profile, audioSamplesB64);
  const json = JSON.stringify(request);
  const binaryEnvelope = encodeValidationBinaryEnvelope(request);
  const textEncoder = new TextEncoder();

  return {
    profile,
    request,
    pcm16Bytes,
    json,
    binaryEnvelope,
    jsonBytes: textEncoder.encode(json).byteLength,
    binaryBytes: binaryEnvelope.byteLength,
    base64Bytes: textEncoder.encode(audioSamplesB64).byteLength,
    decodedPcmBytes: pcm16Bytes.byteLength,
    pcmSha256Hex: bytesToHex(sha256(pcm16Bytes)),
    authorizationDigestHex: bytesToHex(buildValidationRequestDigest(request)),
    jsonSha256Hex: bytesToHex(sha256(textEncoder.encode(json))),
    binarySha256Hex: bytesToHex(sha256(binaryEnvelope)),
  };
}
