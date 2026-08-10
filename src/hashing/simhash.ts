// SimHash 256-bit fingerprint via deterministic random hyperplanes.
//
// Verbatim port of pulse-sdk/src/hashing/simhash.ts so cross-platform
// reproducibility is preserved. The seed string and algorithm steps must
// stay byte-identical with the web SDK; the parity test in
// `__tests__/parity.test.ts` is the gate.
//
// PRIVACY: this function is deterministic over its input. It does not log or
// transmit feature values. Callers must drop the input feature array
// reference after this returns.

import { devWarn } from "@/lib/log";

import { CLIENT_PROJECTION_VERSION, FINGERPRINT_BITS, LEGACY_SIMHASH_SEED } from "./constants";
import { publicProjectionCoefficients } from "./hyperplanes";
import type { TemporalFingerprint } from "./types";
import { TOTAL_FEATURE_COUNT } from "../extraction/types";

const hyperplaneCache = new Map<string, Float64Array>();

function legacyMulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function legacySeed(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return hash;
}

function legacyProjectionCoefficients(dimension: number): Float64Array {
  const random = legacyMulberry32(legacySeed(LEGACY_SIMHASH_SEED));
  return Float64Array.from({ length: FINGERPRINT_BITS * dimension }, () => random() * 2 - 1);
}

function getHyperplanes(dimension: number, projectionVersion: number): Float64Array {
  const cacheKey = `${projectionVersion}:${dimension}`;
  const cached = hyperplaneCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const hyperplanes =
    projectionVersion === 0
      ? legacyProjectionCoefficients(dimension)
      : projectionVersion === 1
        ? publicProjectionCoefficients(dimension)
        : null;
  if (!hyperplanes || projectionVersion > CLIENT_PROJECTION_VERSION) {
    throw new Error(`Unsupported projection version ${projectionVersion}`);
  }
  hyperplaneCache.set(cacheKey, hyperplanes);
  return hyperplanes;
}

/**
 * Compute a 256-bit SimHash fingerprint from a feature vector.
 * Uses deterministic random hyperplanes seeded from the protocol constant.
 * Similar feature vectors produce fingerprints with low Hamming distance.
 */
// Projection 0 binds schema 3 semantics. Projection 1 binds schema 4
// corrections while retaining the same 308-value layout.
const EXPECTED_FEATURE_DIMENSION = TOTAL_FEATURE_COUNT;

export function simhash(features: number[], projectionVersion = 0): TemporalFingerprint {
  if (projectionVersion === 1 && features.length !== EXPECTED_FEATURE_DIMENSION) {
    throw new Error(`Projection version 1 requires exactly ${EXPECTED_FEATURE_DIMENSION} features`);
  }

  if (features.length === 0) {
    return new Array(FINGERPRINT_BITS).fill(0);
  }

  if (features.length !== EXPECTED_FEATURE_DIMENSION) {
    devWarn(
      `[Entros] simhash got ${features.length}-dim vector, expected ${EXPECTED_FEATURE_DIMENSION}. Fingerprint quality may be degraded.`,
    );
  }

  const planes = getHyperplanes(features.length, projectionVersion);
  const fingerprint: TemporalFingerprint = [];

  for (let i = 0; i < FINGERPRINT_BITS; i++) {
    const planeOffset = i * features.length;
    let dot = 0;
    for (let j = 0; j < features.length; j++) {
      dot += (features[j] ?? 0) * (planes[planeOffset + j] ?? 0);
    }
    fingerprint.push(dot >= 0 ? 1 : 0);
  }

  return fingerprint;
}

/**
 * Compute Hamming distance between two fingerprints.
 */
export function hammingDistance(a: TemporalFingerprint, b: TemporalFingerprint): number {
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++;
  }
  return distance;
}
