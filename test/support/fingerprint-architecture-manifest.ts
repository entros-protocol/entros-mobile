import { writeFileSync } from "node:fs";
import { endianness } from "node:os";
import { isAbsolute } from "node:path";

import packageMetadata from "../../package.json";
import { extractFeatures } from "../../src/extraction";
import { generateTBH, packBits } from "../../src/hashing/poseidon";
import { simhash, simhashDotProducts } from "../../src/hashing/simhash";
import { getProjectionDefinition } from "../../src/projection";
import { normalizeCaptureRMS } from "../../src/sensor/audioNormalization";
import { CANONICAL_SAMPLE_RATE, toCanonicalCapture } from "../../src/sensor/resample";
import { canonicalizeTouchSamples } from "../../src/sensor/touch";
import type { SensorData, TouchSample } from "../../src/sensor/types";
import {
  EXPECTED_FINGERPRINT_ARCHITECTURE_FIXTURE_SHA256,
  FINGERPRINT_ARCHITECTURE_FIXED_SALT,
  FINGERPRINT_ARCHITECTURE_FIXTURE_ID,
  FINGERPRINT_ARCHITECTURE_POLICY_CURRENT,
  FINGERPRINT_ARCHITECTURE_POLICY_MINIMUM,
  createFingerprintArchitectureFixture,
  fingerprintArchitectureFixtureDigest,
} from "./fingerprint-architecture-fixture";

const PROJECTION_VERSIONS = [0, 1, 2] as const;
const TARGET_CAPTURE_RMS = 0.05;
const MIN_RMS_FOR_NORMALIZATION = 1e-4;
const MAX_NORMALIZATION_GAIN = 50;
const VOICED_FRAME_RMS = 0.008;
const VOICED_FRAME_SAMPLES = 160;

export interface FingerprintArchitectureProjectionManifest {
  projectionVersion: number;
  featureSchemaVersion: number;
  rawFeaturesF64Hex: string[];
  normalizedFeaturesF64Hex: string[];
  simhashDotProductsF64Hex: string[];
  fingerprintHex: string;
  commitmentHex: string;
}

export interface FingerprintArchitectureManifest {
  schemaVersion: 1;
  implementation: {
    name: string;
    version: string;
  };
  fixture: {
    id: string;
    sha256: string;
    sourceAudioSampleRateHz: number;
    sourceAudioSampleCount: number;
    canonicalAudioSampleRateHz: number;
    canonicalAudioSampleCount: number;
    motionSampleCount: number;
    touchSampleCount: number;
    inputLevel: {
      rmsF64Hex: string;
      peakF64Hex: string;
      gainF64Hex: string;
      gainClipped: boolean;
      voicedFrameRatioF64Hex: string;
    };
  };
  runtime: {
    engine: "node";
    engineVersion: string;
    v8Version: string;
    numericBackend: "javascript-number-float64";
    platform: NodeJS.Platform;
    arch: string;
    endianness: "BE" | "LE";
  };
  commitment: {
    saltDecimal: string;
    byteOrder: "big-endian";
  };
  projectionPolicy: {
    current: 1;
    minimum: 0;
  };
  projections: FingerprintArchitectureProjectionManifest[];
}

export interface FingerprintArchitectureManifestOutput {
  writeFile: (path: string, content: string, options: { encoding: "utf8"; flag: "wx" }) => void;
  writeStdout: (content: string) => void;
}

export interface FingerprintArchitectureManifestEnvironment {
  ENTROS_EMIT_FINGERPRINT_ARCHITECTURE_MANIFEST?: string;
  ENTROS_FINGERPRINT_ARCHITECTURE_MANIFEST_PATH?: string;
}

const NODE_MANIFEST_OUTPUT: FingerprintArchitectureManifestOutput = {
  writeFile: (path, content, options) => {
    writeFileSync(path, content, options);
  },
  writeStdout: (content) => {
    process.stdout.write(content);
  },
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function float64ToHex(value: number): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytesToHex(bytes);
}

function assertFiniteVector(name: string, values: number[]): void {
  const invalidIndex = values.findIndex((value) => !Number.isFinite(value));
  if (invalidIndex >= 0) {
    throw new Error(`${name} contains a non-finite value at ${invalidIndex}`);
  }
}

function describeFixtureInputLevel(samples: Float32Array): {
  rms: number;
  peak: number;
  gain: number;
  gainClipped: boolean;
  voicedFrameRatio: number;
} {
  if (samples.length === 0) {
    return { rms: 0, peak: 0, gain: 1, gainClipped: false, voicedFrameRatio: 0 };
  }

  let sumSquares = 0;
  let peak = 0;
  let voicedFrames = 0;
  let totalFrames = 0;
  let frameSumSquares = 0;
  let frameLength = 0;

  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    const square = sample * sample;
    sumSquares += square;
    peak = Math.max(peak, Math.abs(sample));
    frameSumSquares += square;
    frameLength += 1;

    if (frameLength === VOICED_FRAME_SAMPLES) {
      if (Math.sqrt(frameSumSquares / frameLength) > VOICED_FRAME_RMS) voicedFrames += 1;
      totalFrames += 1;
      frameSumSquares = 0;
      frameLength = 0;
    }
  }

  if (frameLength > 0) {
    if (Math.sqrt(frameSumSquares / frameLength) > VOICED_FRAME_RMS) voicedFrames += 1;
    totalFrames += 1;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  return {
    rms,
    peak,
    gain:
      rms < MIN_RMS_FOR_NORMALIZATION
        ? 1
        : Math.min(TARGET_CAPTURE_RMS / rms, MAX_NORMALIZATION_GAIN),
    gainClipped:
      rms >= MIN_RMS_FOR_NORMALIZATION && TARGET_CAPTURE_RMS / rms > MAX_NORMALIZATION_GAIN,
    voicedFrameRatio: totalFrames > 0 ? voicedFrames / totalFrames : 0,
  };
}

export function emitFingerprintArchitectureManifest(
  manifest: FingerprintArchitectureManifest,
  environment: FingerprintArchitectureManifestEnvironment = {
    ENTROS_EMIT_FINGERPRINT_ARCHITECTURE_MANIFEST:
      process.env.ENTROS_EMIT_FINGERPRINT_ARCHITECTURE_MANIFEST,
    ENTROS_FINGERPRINT_ARCHITECTURE_MANIFEST_PATH:
      process.env.ENTROS_FINGERPRINT_ARCHITECTURE_MANIFEST_PATH,
  },
  output: FingerprintArchitectureManifestOutput = NODE_MANIFEST_OUTPUT,
): void {
  if (environment.ENTROS_EMIT_FINGERPRINT_ARCHITECTURE_MANIFEST !== "1") return;

  const content = `${JSON.stringify(manifest)}\n`;
  const outputPath = environment.ENTROS_FINGERPRINT_ARCHITECTURE_MANIFEST_PATH;
  if (outputPath === undefined) {
    output.writeStdout(content);
    return;
  }
  if (!isAbsolute(outputPath)) {
    throw new Error("Fingerprint architecture manifest path must be absolute");
  }
  output.writeFile(outputPath, content, { encoding: "utf8", flag: "wx" });
}

function fingerprintToBytes(bits: number[]): Uint8Array {
  if (bits.length !== 256) {
    throw new Error(`Expected 256-bit fingerprint, got ${bits.length}`);
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bits.length; index++) {
    if (bits[index] === 1) {
      bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (1 << (index & 7));
    }
  }
  return bytes;
}

function littleEndianBytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0);
  }
  return value;
}

function assertFingerprintPacking(bits: number[], bytes: Uint8Array): void {
  const packed = packBits(bits);
  const low = littleEndianBytesToBigInt(bytes.subarray(0, 16));
  const high = littleEndianBytesToBigInt(bytes.subarray(16));
  if (packed.lo !== low || packed.hi !== high) {
    throw new Error("Fingerprint byte packing differs from the production field packing");
  }
}

interface FixtureTouchSample {
  timestamp: number;
  x: number;
  y: number;
  pressure: number;
}

function toMobileTouch(samples: FixtureTouchSample[]): TouchSample[] {
  return samples.map((sample) => ({
    t: sample.timestamp,
    x: sample.x,
    y: sample.y,
    pressure: sample.pressure,
  }));
}

function sampleRateFromTimestamps(samples: { timestamp: number }[]): number {
  const first = samples[0]?.timestamp;
  const last = samples[samples.length - 1]?.timestamp;
  if (first === undefined || last === undefined || samples.length < 2 || last <= first) {
    throw new Error("Fingerprint architecture motion timestamps do not define a duration");
  }
  return ((samples.length - 1) * 1_000) / (last - first);
}

export async function buildFingerprintArchitectureManifest(): Promise<FingerprintArchitectureManifest> {
  const fixture = createFingerprintArchitectureFixture();
  const fixtureDigest = fingerprintArchitectureFixtureDigest(fixture);
  if (fixtureDigest !== EXPECTED_FINGERPRINT_ARCHITECTURE_FIXTURE_SHA256) {
    throw new Error(`Fingerprint architecture fixture digest mismatch: ${fixtureDigest}`);
  }

  const canonicalAudio = await toCanonicalCapture(fixture.sourcePcm, fixture.sourceSampleRate);
  if (canonicalAudio.sampleRate !== CANONICAL_SAMPLE_RATE) {
    throw new Error("Fingerprint architecture audio did not canonicalize");
  }

  const inputLevel = describeFixtureInputLevel(canonicalAudio.samples);
  const normalizedAudio = normalizeCaptureRMS(canonicalAudio.samples);
  const audioWindowMs = (normalizedAudio.length * 1_000) / canonicalAudio.sampleRate;
  const sourceTouch = toMobileTouch(fixture.touch);
  const projections: FingerprintArchitectureProjectionManifest[] = [];

  for (const projectionVersion of PROJECTION_VERSIONS) {
    const canonicalTouch = canonicalizeTouchSamples(sourceTouch, projectionVersion);
    const sensorData: SensorData = {
      audio: {
        pcm: normalizedAudio,
        sampleRate: canonicalAudio.sampleRate,
        nativeSampleRate: fixture.sourceSampleRate,
        durationMs: audioWindowMs,
        startedAt: 0,
      },
      motion: {
        samples: fixture.motion.map((sample) => ({
          t: sample.timestamp,
          ax: sample.ax,
          ay: sample.ay,
          az: sample.az,
          gx: sample.gx,
          gy: sample.gy,
          gz: sample.gz,
        })),
        sampleRate: sampleRateFromTimestamps(fixture.motion),
        durationMs: audioWindowMs,
        startedAt: 0,
      },
      touch: {
        samples: canonicalTouch,
        durationMs: audioWindowMs,
      },
    };

    const features = await extractFeatures(sensorData, projectionVersion);
    assertFiniteVector("Raw feature vector", features.raw);
    assertFiniteVector("Normalized feature vector", features.normalized);
    if (features.raw.length !== 308 || features.normalized.length !== 308) {
      throw new Error(`Projection ${projectionVersion} did not produce 308 features`);
    }

    const fingerprint = simhash(features.normalized, projectionVersion);
    const dotProducts = simhashDotProducts(features.normalized, projectionVersion);
    assertFiniteVector("SimHash dot products", dotProducts);
    const fingerprintBytes = fingerprintToBytes(fingerprint);
    assertFingerprintPacking(fingerprint, fingerprintBytes);
    const tbh = await generateTBH(fingerprint, FINGERPRINT_ARCHITECTURE_FIXED_SALT);
    if (tbh.salt !== FINGERPRINT_ARCHITECTURE_FIXED_SALT) {
      throw new Error("Fingerprint architecture TBH did not retain the fixed salt");
    }

    projections.push({
      projectionVersion,
      featureSchemaVersion: getProjectionDefinition(projectionVersion).featureSchemaVersion,
      rawFeaturesF64Hex: features.raw.map(float64ToHex),
      normalizedFeaturesF64Hex: features.normalized.map(float64ToHex),
      simhashDotProductsF64Hex: dotProducts.map(float64ToHex),
      fingerprintHex: bytesToHex(fingerprintBytes),
      commitmentHex: bytesToHex(tbh.commitmentBytes),
    });
  }

  return {
    schemaVersion: 1,
    implementation: {
      name: `${packageMetadata.name}-node-source-path`,
      version: packageMetadata.version,
    },
    fixture: {
      id: FINGERPRINT_ARCHITECTURE_FIXTURE_ID,
      sha256: fixtureDigest,
      sourceAudioSampleRateHz: fixture.sourceSampleRate,
      sourceAudioSampleCount: fixture.sourcePcm.length,
      canonicalAudioSampleRateHz: canonicalAudio.sampleRate,
      canonicalAudioSampleCount: canonicalAudio.samples.length,
      motionSampleCount: fixture.motion.length,
      touchSampleCount: fixture.touch.length,
      inputLevel: {
        rmsF64Hex: float64ToHex(inputLevel.rms),
        peakF64Hex: float64ToHex(inputLevel.peak),
        gainF64Hex: float64ToHex(inputLevel.gain),
        gainClipped: inputLevel.gainClipped,
        voicedFrameRatioF64Hex: float64ToHex(inputLevel.voicedFrameRatio),
      },
    },
    runtime: {
      engine: "node",
      engineVersion: process.versions.node,
      v8Version: process.versions.v8,
      numericBackend: "javascript-number-float64",
      platform: process.platform,
      arch: process.arch,
      endianness: endianness(),
    },
    commitment: {
      saltDecimal: FINGERPRINT_ARCHITECTURE_FIXED_SALT.toString(10),
      byteOrder: "big-endian",
    },
    projectionPolicy: {
      current: FINGERPRINT_ARCHITECTURE_POLICY_CURRENT,
      minimum: FINGERPRINT_ARCHITECTURE_POLICY_MINIMUM,
    },
    projections,
  };
}
