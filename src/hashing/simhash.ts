// SimHash 256-bit fingerprint via deterministic random hyperplanes.
//
// Mirrors Pulse at the protocol boundary. The seed, transcript, accumulation
// order, and bit packing must stay byte-identical across both clients.
//
// PRIVACY: this function is deterministic over its input. It does not log or
// transmit feature values. Callers must drop the input feature array
// reference after this returns.

import { devWarn } from "@/lib/log";

import { FINGERPRINT_BITS, LEGACY_SIMHASH_SEED } from "./constants";
import { publicProjectionCoefficients } from "./hyperplanes";
import type { TemporalFingerprint } from "./types";
import { TOTAL_FEATURE_COUNT } from "../extraction/types";
import { getProjectionDefinition } from "../projection";

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

  const definition = getProjectionDefinition(projectionVersion);
  const hyperplanes =
    definition.hyperplanes.family === "legacy"
      ? legacyProjectionCoefficients(dimension)
      : publicProjectionCoefficients(dimension, definition.hyperplanes.transcriptVersion);
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

function validateFeatureVector(features: number[], projectionVersion: number): void {
  const invalidIndex = features.findIndex((feature) => !Number.isFinite(feature));
  if (invalidIndex >= 0) {
    throw new Error(`Feature vector contains a non-finite value at ${invalidIndex}`);
  }

  if (
    getProjectionDefinition(projectionVersion).hyperplanes.family === "public" &&
    features.length !== EXPECTED_FEATURE_DIMENSION
  ) {
    throw new Error(
      `Projection version ${projectionVersion} requires exactly ${EXPECTED_FEATURE_DIMENSION} features`,
    );
  }

  if (features.length !== 0 && features.length !== EXPECTED_FEATURE_DIMENSION) {
    devWarn(
      `[Entros] simhash got ${features.length}-dim vector, expected ${EXPECTED_FEATURE_DIMENSION}. Fingerprint quality may be degraded.`,
    );
  }
}

function accumulatePlaneDot(features: number[], planes: Float64Array, planeOffset: number): number {
  let dot = 0;
  for (let index = 0; index < features.length; index++) {
    dot += (features[index] ?? 0) * (planes[planeOffset + index] ?? 0);
  }
  return dot;
}

/**
 * Return the signed projection value behind each SimHash bit.
 *
 * This source-only diagnostic lets parity tests distinguish feature drift from
 * a bit flip near zero. The hashing index does not export it.
 */
export function simhashDotProducts(features: number[], projectionVersion = 0): number[] {
  validateFeatureVector(features, projectionVersion);
  if (features.length === 0) {
    return new Array(FINGERPRINT_BITS).fill(0);
  }

  const planes = getHyperplanes(features.length, projectionVersion);
  const dotProducts = new Array<number>(FINGERPRINT_BITS);

  for (let i = 0; i < FINGERPRINT_BITS; i++) {
    const planeOffset = i * features.length;
    dotProducts[i] = accumulatePlaneDot(features, planes, planeOffset);
  }

  return dotProducts;
}

export function simhash(features: number[], projectionVersion = 0): TemporalFingerprint {
  validateFeatureVector(features, projectionVersion);

  if (features.length === 0) {
    return new Array(FINGERPRINT_BITS).fill(0);
  }

  const planes = getHyperplanes(features.length, projectionVersion);
  const fingerprint: TemporalFingerprint = [];

  for (let i = 0; i < FINGERPRINT_BITS; i++) {
    const planeOffset = i * features.length;
    const dot = accumulatePlaneDot(features, planes, planeOffset);
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
