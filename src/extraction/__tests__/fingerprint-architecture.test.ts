import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalizeTouchSamples } from "@/sensor/touch";
import type { TouchSample } from "@/sensor/types";

import {
  EXPECTED_FINGERPRINT_ARCHITECTURE_FIXTURE_SHA256,
  EXPECTED_FINGERPRINT_ARCHITECTURE_OUTPUTS,
  FINGERPRINT_ARCHITECTURE_FIXED_SALT,
  FINGERPRINT_ARCHITECTURE_FIXTURE_ID,
  createFingerprintArchitectureFixture,
  fingerprintArchitectureFixtureDigest,
} from "../../../test/support/fingerprint-architecture-fixture";
import {
  buildFingerprintArchitectureManifest,
  emitFingerprintArchitectureManifest,
  type FingerprintArchitectureManifest,
  type FingerprintArchitectureManifestOutput,
} from "../../../test/support/fingerprint-architecture-manifest";

const EXPECTED_PROJECTIONS = [
  {
    projectionVersion: 0,
    featureSchemaVersion: 3,
  },
  {
    projectionVersion: 1,
    featureSchemaVersion: 4,
  },
  {
    projectionVersion: 2,
    featureSchemaVersion: 5,
  },
] as const;

const MANIFEST_TIMEOUT_MS = 120_000;

function hexToFloat64(hex: string): number {
  const bytes = Uint8Array.from({ length: 8 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
  return new DataView(bytes.buffer).getFloat64(0, false);
}

function fingerprintBits(hex: string): number[] {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
  return Array.from({ length: 256 }, (_, index) =>
    ((bytes[index >> 3] ?? 0) & (1 << (index & 7))) === 0 ? 0 : 1,
  );
}

function sourceTouchSamples(): TouchSample[] {
  return createFingerprintArchitectureFixture().touch.map((sample) => ({
    t: sample.timestamp,
    x: sample.x,
    y: sample.y,
    pressure: sample.pressure,
  }));
}

describe("mobile Node source-path fingerprint architecture measurement", () => {
  let manifest: FingerprintArchitectureManifest;

  beforeAll(async () => {
    manifest = await buildFingerprintArchitectureManifest();
  }, MANIFEST_TIMEOUT_MS);

  test("pins the canonical Pulse fixture byte contract", () => {
    const first = createFingerprintArchitectureFixture();
    const second = createFingerprintArchitectureFixture();

    expect(fingerprintArchitectureFixtureDigest(first)).toBe(
      EXPECTED_FINGERPRINT_ARCHITECTURE_FIXTURE_SHA256,
    );
    expect(fingerprintArchitectureFixtureDigest(second)).toBe(
      EXPECTED_FINGERPRINT_ARCHITECTURE_FIXTURE_SHA256,
    );
    expect(first).toEqual(second);
    expect(second).not.toBe(first);
    expect(second.sourcePcm).not.toBe(first.sourcePcm);
    expect(second.motion).not.toBe(first.motion);
    expect(second.motion[0]).not.toBe(first.motion[0]);
    expect(second.touch).not.toBe(first.touch);
    expect(second.touch[0]).not.toBe(first.touch[0]);
  });

  test("uses the source touch trace for legacy projections and canonicalizes projection 2", () => {
    const source = sourceTouchSamples();

    expect(canonicalizeTouchSamples(source, 0)).toBe(source);
    expect(canonicalizeTouchSamples(source, 1)).toBe(source);
    expect(canonicalizeTouchSamples(source, 2)).toHaveLength(361);
  });

  test(
    "is byte-value deterministic within one Node runtime",
    async () => {
      const repeatedManifest = await buildFingerprintArchitectureManifest();
      expect(repeatedManifest).toEqual(manifest);
    },
    MANIFEST_TIMEOUT_MS,
  );

  test("emits the shared Node source-path manifest contract", () => {
    emitFingerprintArchitectureManifest(manifest);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      implementation: {
        name: "entros-mobile-node-source-path",
        version: "0.1.0",
      },
      fixture: {
        id: FINGERPRINT_ARCHITECTURE_FIXTURE_ID,
        sha256: EXPECTED_FINGERPRINT_ARCHITECTURE_FIXTURE_SHA256,
        sourceAudioSampleRateHz: 48_000,
        sourceAudioSampleCount: 576_000,
        canonicalAudioSampleRateHz: 16_000,
        canonicalAudioSampleCount: 192_000,
        motionSampleCount: 769,
        touchSampleCount: 769,
        inputLevel: {
          rmsF64Hex: expect.stringMatching(/^[0-9a-f]{16}$/),
          peakF64Hex: expect.stringMatching(/^[0-9a-f]{16}$/),
          gainF64Hex: expect.stringMatching(/^[0-9a-f]{16}$/),
          gainClipped: false,
          voicedFrameRatioF64Hex: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      },
      runtime: {
        engine: "node",
        engineVersion: process.versions.node,
        v8Version: process.versions.v8,
        numericBackend: "javascript-number-float64",
        platform: process.platform,
        arch: process.arch,
      },
      commitment: {
        saltDecimal: FINGERPRINT_ARCHITECTURE_FIXED_SALT.toString(10),
        byteOrder: "big-endian",
      },
      projectionPolicy: {
        current: 1,
        minimum: 0,
      },
    });

    expect(manifest.projections).toHaveLength(3);
    for (const [index, projection] of manifest.projections.entries()) {
      const expected = EXPECTED_PROJECTIONS[index]!;
      expect(projection).toMatchObject(expected);
      expect(projection).toMatchObject(EXPECTED_FINGERPRINT_ARCHITECTURE_OUTPUTS[index]!);
      expect(projection.rawFeaturesF64Hex).toHaveLength(308);
      expect(projection.normalizedFeaturesF64Hex).toHaveLength(308);
      expect(projection.simhashDotProductsF64Hex).toHaveLength(256);
      for (const hex of projection.rawFeaturesF64Hex) {
        expect(hex).toMatch(/^[0-9a-f]{16}$/);
      }
      for (const hex of projection.normalizedFeaturesF64Hex) {
        expect(hex).toMatch(/^[0-9a-f]{16}$/);
      }
      for (const hex of projection.simhashDotProductsF64Hex) {
        expect(hex).toMatch(/^[0-9a-f]{16}$/);
      }
      expect(projection.fingerprintHex).toMatch(/^[0-9a-f]{64}$/);
      expect(projection.commitmentHex).toMatch(/^[0-9a-f]{64}$/);

      const bits = fingerprintBits(projection.fingerprintHex);
      const signs = projection.simhashDotProductsF64Hex.map((hex) =>
        hexToFloat64(hex) >= 0 ? 1 : 0,
      );
      expect(signs).toEqual(bits);
    }
  });

  test("isolates projection 2 drift to normalized touch processing", () => {
    const projectionOne = manifest.projections[1]!;
    const projectionTwo = manifest.projections[2]!;

    expect(projectionTwo.rawFeaturesF64Hex.slice(0, 251)).toEqual(
      projectionOne.rawFeaturesF64Hex.slice(0, 251),
    );
    expect(projectionTwo.normalizedFeaturesF64Hex.slice(0, 251)).toEqual(
      projectionOne.normalizedFeaturesF64Hex.slice(0, 251),
    );
    expect(projectionTwo.rawFeaturesF64Hex.slice(251)).not.toEqual(
      projectionOne.rawFeaturesF64Hex.slice(251),
    );
  });

  test("writes an explicit absolute output path with create-new semantics", () => {
    const writes: Parameters<FingerprintArchitectureManifestOutput["writeFile"]>[] = [];
    let stdout = "";
    const output: FingerprintArchitectureManifestOutput = {
      writeFile: (...parameters) => {
        writes.push(parameters);
      },
      writeStdout: (content) => {
        stdout += content;
      },
    };
    const outputPath = resolve(process.cwd(), "fingerprint-architecture-manifest.json");

    emitFingerprintArchitectureManifest(
      manifest,
      {
        ENTROS_EMIT_FINGERPRINT_ARCHITECTURE_MANIFEST: "1",
        ENTROS_FINGERPRINT_ARCHITECTURE_MANIFEST_PATH: outputPath,
      },
      output,
    );

    expect(writes).toEqual([
      [outputPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx" }],
    ]);
    expect(stdout).toBe("");
  });

  test("uses stdout only when emission has no output path", () => {
    let stdout = "";
    const output: FingerprintArchitectureManifestOutput = {
      writeFile: () => {
        throw new Error("Unexpected file write");
      },
      writeStdout: (content) => {
        stdout += content;
      },
    };

    emitFingerprintArchitectureManifest(
      manifest,
      { ENTROS_EMIT_FINGERPRINT_ARCHITECTURE_MANIFEST: "1" },
      output,
    );

    expect(stdout).toBe(`${JSON.stringify(manifest)}\n`);
  });

  test("rejects relative paths before writing", () => {
    let writeAttempted = false;
    const output: FingerprintArchitectureManifestOutput = {
      writeFile: () => {
        writeAttempted = true;
      },
      writeStdout: () => {
        throw new Error("Unexpected stdout write");
      },
    };

    expect(() =>
      emitFingerprintArchitectureManifest(
        manifest,
        {
          ENTROS_EMIT_FINGERPRINT_ARCHITECTURE_MANIFEST: "1",
          ENTROS_FINGERPRINT_ARCHITECTURE_MANIFEST_PATH: "manifest.json",
        },
        output,
      ),
    ).toThrow("Fingerprint architecture manifest path must be absolute");
    expect(writeAttempted).toBe(false);
  });

  test("refuses to overwrite an existing file", () => {
    const existingPath = resolve(process.cwd(), "package.json");
    const before = readFileSync(existingPath);
    let writeError: unknown;

    try {
      emitFingerprintArchitectureManifest(manifest, {
        ENTROS_EMIT_FINGERPRINT_ARCHITECTURE_MANIFEST: "1",
        ENTROS_FINGERPRINT_ARCHITECTURE_MANIFEST_PATH: existingPath,
      });
    } catch (error) {
      writeError = error;
    }

    expect(writeError).toMatchObject({ code: "EEXIST" });
    expect(readFileSync(existingPath)).toEqual(before);
  });
});
