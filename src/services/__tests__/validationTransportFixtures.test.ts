import packageMetadata from "../../../package.json";

import {
  buildSyntheticValidationTransportFixture,
  decodeValidationBinaryEnvelope,
  encodeValidationBinaryEnvelope,
  VALIDATION_TRANSPORT_PROFILES,
  type SyntheticValidationTransportFixture,
} from "../validationTransportFixtures";
import { buildValidationRequestDigest, bytesToHex } from "../validationAuthorization";

const EXECUTOR_BODY_LIMIT_BYTES = 1_048_576;
const SERIALIZATION_RUNS = 100;
const COMMON_REQUEST_FIELDS = [
  "accel_magnitude",
  "audio_sample_rate_hz",
  "audio_samples_b64",
  "baseline_reset",
  "commitment_new_hex",
  "curve_trace",
  "f0_contour",
  "features",
  "projection_version",
  "receipt_purpose",
  "request_receipt",
  "wallet_id",
] as const;

const expectedStableValues = {
  "projection-1-mobile-maximum": {
    jsonBytes: 531_745,
    binaryBytes: 403_738,
    base64Bytes: 512_000,
    decodedPcmBytes: 384_000,
    pcmSha256Hex: "1d48b0b5fbfba855850def32635aa57da79de251f0922c32cc6fac4da0b63358",
    authorizationDigestHex: "7e6590937e09f926165eb28391a6ba7d306b468ef0609ed64b5268aaf6d05f08",
    jsonSha256Hex: "b9fc7f1c6f8a28f6bd05463d24bc10f91503399b3631c2a7e5c7fed4aef06b16",
    binarySha256Hex: "7aea52557d6f85c452d5929207da82944da1694c75fade9632f52f4c5f91e494",
  },
  "projection-1-service-ceiling": {
    jsonBytes: 883_039,
    binaryBytes: 669_696,
    base64Bytes: 853_336,
    decodedPcmBytes: 640_000,
    pcmSha256Hex: "76613da053ac8dbe3d1d42b1f34128c350ea2d80f94f2bef5893c67a8f18f071",
    authorizationDigestHex: "1ca4ae743586ea524c6a8219ee58f94346c799bb51cb82be6f536c4e77150fde",
    jsonSha256Hex: "7c5aaad906077f4a0e57f631ff76cc973e0e7eb50e9f14d6a06fef9e16533f72",
    binarySha256Hex: "9c67497f3221ae48e57be1f6285fc30dae941221d57c78d11bde3c6f8af97153",
  },
  "projection-2-mobile-maximum": {
    jsonBytes: 534_424,
    binaryBytes: 406_417,
    base64Bytes: 512_000,
    decodedPcmBytes: 384_000,
    pcmSha256Hex: "1d48b0b5fbfba855850def32635aa57da79de251f0922c32cc6fac4da0b63358",
    authorizationDigestHex: "e1e0f756b79cbba6effc4bcff726c75cc6ad0cf248e6498d82b08572d539830f",
    jsonSha256Hex: "dc99a20067880dfe5b987019745339a88ae0f6c77ca3b5e37cfee8a0ca70ab61",
    binarySha256Hex: "d1562440f22b4b0c7a10342af215e59ce742d4aaca4a8a886be451bfb3b4d4f0",
  },
  "projection-2-service-ceiling": {
    jsonBytes: 885_718,
    binaryBytes: 672_375,
    base64Bytes: 853_336,
    decodedPcmBytes: 640_000,
    pcmSha256Hex: "76613da053ac8dbe3d1d42b1f34128c350ea2d80f94f2bef5893c67a8f18f071",
    authorizationDigestHex: "4abdbe8e105ecbe49c60f8d0d8444df6bdf89889094b55e8ea481209a109b7ec",
    jsonSha256Hex: "317e1436ccb5345c3882f874438f7e08a3a108c916281e9243f7bc2e304c771e",
    binarySha256Hex: "ba51bde06daee5cb0efe1024302c283edd64f9c39c9418eefe5617e76265f9a5",
  },
} as const;

const fixtures = new Map(
  VALIDATION_TRANSPORT_PROFILES.map((profile) => [
    profile.name,
    buildSyntheticValidationTransportFixture(profile.name),
  ]),
);

function fixture(name: (typeof VALIDATION_TRANSPORT_PROFILES)[number]["name"]) {
  const value = fixtures.get(name);
  if (!value) throw new Error(`Missing fixture: ${name}`);
  return value;
}

function pcmSampleAt(value: SyntheticValidationTransportFixture, index: number): number {
  return new DataView(
    value.pcm16Bytes.buffer,
    value.pcm16Bytes.byteOffset,
    value.pcm16Bytes.byteLength,
  ).getInt16(index * 2, true);
}

function percentile(sorted: number[], proportion: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * proportion) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("Cannot measure an empty sample");
  return value;
}

describe("synthetic validation transport fixtures", () => {
  test.each(VALIDATION_TRANSPORT_PROFILES)(
    "$name uses deterministic canonical PCM and complete common fields",
    (profile) => {
      const value = fixture(profile.name);
      const sampleCount = (profile.durationMs * 16_000) / 1_000;

      expect(value.pcm16Bytes).toHaveLength(sampleCount * 2);
      for (const index of [0, 1, Math.floor(sampleCount / 2), sampleCount - 1]) {
        expect(pcmSampleAt(value, index)).toBe(((index * 1_103 + 7_919) & 0xffff) - 32_768);
      }
      expect(value.request).toMatchObject({
        projection_version: profile.projectionVersion,
        wallet_id: "11111111111111111111111111111111",
        audio_sample_rate_hz: 16_000,
        commitment_new_hex: "11".repeat(32),
        request_receipt: true,
        receipt_purpose: "mint",
        baseline_reset: false,
      });
      expect(value.request).not.toHaveProperty("client_signals");
      expect(value.request).not.toHaveProperty("capture_timing");
      expect(value.request.features).toEqual(
        Array.from({ length: 308 }, (_, index) => (index - 154) / 16),
      );
      expect(value.request.f0_contour).toHaveLength(profile.durationMs / 10);
      expect(value.request.accel_magnitude).toHaveLength(profile.durationMs / 10);
      expect(value.request.curve_trace?.points).toHaveLength(64);
      expect(value.request.curve_trace?.duration_ms).toBe(profile.durationMs);
    },
  );

  test.each(VALIDATION_TRANSPORT_PROFILES)(
    "$name stays below the executor limit and preserves stable bytes",
    (profile) => {
      const value = fixture(profile.name);
      const expected = expectedStableValues[profile.name];

      expect(value.jsonBytes).toBeLessThan(EXECUTOR_BODY_LIMIT_BYTES);
      expect({
        jsonBytes: value.jsonBytes,
        binaryBytes: value.binaryBytes,
        base64Bytes: value.base64Bytes,
        decodedPcmBytes: value.decodedPcmBytes,
        pcmSha256Hex: value.pcmSha256Hex,
        authorizationDigestHex: value.authorizationDigestHex,
        jsonSha256Hex: value.jsonSha256Hex,
        binarySha256Hex: value.binarySha256Hex,
      }).toEqual(expected);
      expect(buildSyntheticValidationTransportFixture(profile.name).authorizationDigestHex).toBe(
        value.authorizationDigestHex,
      );
    },
  );

  test("projection 2 adds only compatibility evidence and fixed-width authorization", () => {
    for (const duration of ["mobile-maximum", "service-ceiling"] as const) {
      const projectionOne = fixture(`projection-1-${duration}`);
      const projectionTwo = fixture(`projection-2-${duration}`);

      expect(projectionOne.request).not.toHaveProperty("compatibility_evidence");
      expect(projectionOne.request).not.toHaveProperty("wallet_authorization");
      expect(projectionTwo.request.compatibility_evidence).toEqual({
        projection_version: 1,
        feature_schema_version: 4,
        features: Array.from({ length: 308 }, (_, index) => (index - 154) / 32),
      });
      expect(projectionTwo.request.wallet_authorization?.nonce).toHaveLength(32);
      expect(projectionTwo.request.wallet_authorization?.nonce).toEqual(new Array(32).fill(0x5a));
      expect(projectionTwo.request.wallet_authorization?.signature_hex).toBe("ab".repeat(64));
    }
  });

  test("request bodies exclude participant data and raw sensor streams", () => {
    for (const value of fixtures.values()) {
      const expectedFields =
        value.profile.projectionVersion === 2
          ? [...COMMON_REQUEST_FIELDS, "compatibility_evidence", "wallet_authorization"]
          : [...COMMON_REQUEST_FIELDS];
      expect(Object.keys(value.request).sort()).toEqual(expectedFields.sort());
      for (const forbiddenField of [
        "behavioral_fingerprint",
        "fingerprint",
        "full_touch",
        "full_touch_events",
        "motion",
        "motion_samples",
        "raw_motion",
        "touch",
        "touch_events",
        "touch_samples",
        "raw_touch",
        "compatibility_touch",
        "audio_samples",
        "study",
      ]) {
        expect(value.request).not.toHaveProperty(forbiddenField);
      }
      for (const point of value.request.curve_trace?.points ?? []) {
        expect(point).toHaveLength(2);
      }
    }
  });

  test("12-second fixtures remain the client maximum while 20-second fixtures model service headroom", () => {
    for (const projectionVersion of [1, 2] as const) {
      const clientMaximum = fixture(`projection-${projectionVersion}-mobile-maximum`);
      const serviceCeiling = fixture(`projection-${projectionVersion}-service-ceiling`);

      expect(clientMaximum.profile.durationMs).toBe(12_000);
      expect(serviceCeiling.profile.durationMs).toBe(20_000);
      expect(clientMaximum.decodedPcmBytes).toBe(384_000);
      expect(serviceCeiling.decodedPcmBytes).toBe(640_000);
      expect(serviceCeiling.jsonBytes).toBeGreaterThan(clientMaximum.jsonBytes);
    }
  });

  test.each(VALIDATION_TRANSPORT_PROFILES)(
    "$name binary envelope preserves the full request, PCM, numbers, and authorization digest",
    (profile) => {
      const value = fixture(profile.name);
      const decoded = decodeValidationBinaryEnvelope(value.binaryEnvelope);

      const { audio_samples_b64: decodedAudio, ...decodedMetadata } = decoded;
      const { audio_samples_b64: requestAudio, ...requestMetadata } = value.request;
      expect(decodedMetadata).toEqual(requestMetadata);
      expect(decodedAudio).toBe(requestAudio);
      const rebuilt = buildSyntheticValidationTransportFixture(profile.name);
      expect(rebuilt.binarySha256Hex).toBe(value.binarySha256Hex);
      expect(bytesEqual(rebuilt.binaryEnvelope, value.binaryEnvelope)).toBe(true);
      expect(bytesEqual(encodeValidationBinaryEnvelope(decoded), value.binaryEnvelope)).toBe(true);
      expect(bytesToHex(buildValidationRequestDigest(decoded))).toBe(value.authorizationDigestHex);
    },
  );
});

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => right[index] === byte);
}

function replaceEnvelopeMetadata(envelope: Uint8Array, metadata: unknown): Uint8Array {
  const sourceHeader = new DataView(envelope.buffer, envelope.byteOffset, 16);
  const sourceMetadataLength = sourceHeader.getUint32(8, true);
  const sourcePcmLength = sourceHeader.getUint32(12, true);
  const sourcePcm = envelope.subarray(16 + sourceMetadataLength);
  expect(sourcePcm).toHaveLength(sourcePcmLength);

  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const result = new Uint8Array(16 + metadataBytes.byteLength + sourcePcm.byteLength);
  result.set(envelope.subarray(0, 16), 0);
  const resultHeader = new DataView(result.buffer);
  resultHeader.setUint32(8, metadataBytes.byteLength, true);
  resultHeader.setUint32(12, sourcePcm.byteLength, true);
  result.set(metadataBytes, 16);
  result.set(sourcePcm, 16 + metadataBytes.byteLength);
  return result;
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

describe("versioned binary validation envelope rejection", () => {
  const value = fixture("projection-2-mobile-maximum");

  test("rejects truncated headers and bodies", () => {
    expect(() => decodeValidationBinaryEnvelope(value.binaryEnvelope.subarray(0, 15))).toThrow(
      "Truncated binary envelope header",
    );
    expect(() => decodeValidationBinaryEnvelope(value.binaryEnvelope.subarray(0, -1))).toThrow(
      "Truncated binary envelope body",
    );
  });

  test("rejects bad magic, unknown versions, and invalid flags", () => {
    const badMagic = value.binaryEnvelope.slice();
    badMagic[0] = 0;
    expect(() => decodeValidationBinaryEnvelope(badMagic)).toThrow("Invalid binary envelope magic");

    const unknownVersion = value.binaryEnvelope.slice();
    new DataView(unknownVersion.buffer).setUint16(4, 2, true);
    expect(() => decodeValidationBinaryEnvelope(unknownVersion)).toThrow(
      "Unsupported binary envelope version 2",
    );

    const invalidFlags = value.binaryEnvelope.slice();
    new DataView(invalidFlags.buffer).setUint16(6, 3, true);
    expect(() => decodeValidationBinaryEnvelope(invalidFlags)).toThrow(
      "Invalid binary envelope flags",
    );
  });

  test("rejects malformed metadata, duplicate audio, and trailing bytes", () => {
    const malformedMetadata = value.binaryEnvelope.slice();
    malformedMetadata[16] = 0xff;
    expect(() => decodeValidationBinaryEnvelope(malformedMetadata)).toThrow(
      "Invalid binary envelope metadata",
    );

    const duplicateAudio = replaceEnvelopeMetadata(value.binaryEnvelope, {
      ...value.request,
      audio_samples_b64: "AA==",
    });
    expect(() => decodeValidationBinaryEnvelope(duplicateAudio)).toThrow(
      "Binary envelope metadata duplicates PCM",
    );

    const missingRequiredFields = replaceEnvelopeMetadata(value.binaryEnvelope, {});
    expect(() => decodeValidationBinaryEnvelope(missingRequiredFields)).toThrow(
      "Invalid binary envelope metadata",
    );

    const invalidUtf8 = value.binaryEnvelope.slice();
    const walletOffset = findBytes(
      invalidUtf8.subarray(16, 16 + new DataView(invalidUtf8.buffer).getUint32(8, true)),
      new TextEncoder().encode(value.request.wallet_id),
    );
    expect(walletOffset).toBeGreaterThanOrEqual(0);
    invalidUtf8[16 + walletOffset] = 0xff;
    expect(() => decodeValidationBinaryEnvelope(invalidUtf8)).toThrow(
      "Invalid binary envelope metadata",
    );

    const trailingBytes = new Uint8Array(value.binaryEnvelope.byteLength + 1);
    trailingBytes.set(value.binaryEnvelope);
    expect(() => decodeValidationBinaryEnvelope(trailingBytes)).toThrow(
      "Trailing binary envelope bytes",
    );
  });

  test("rejects empty and odd-length PCM16", () => {
    for (const audio_samples_b64 of ["", "AA=="]) {
      expect(() => encodeValidationBinaryEnvelope({ ...value.request, audio_samples_b64 })).toThrow(
        "Binary envelope requires non-empty PCM16",
      );
    }

    const header = new DataView(
      value.binaryEnvelope.buffer,
      value.binaryEnvelope.byteOffset,
      value.binaryEnvelope.byteLength,
    );
    const metadataLength = header.getUint32(8, true);
    const pcmLength = header.getUint32(12, true);

    const emptyPcm = value.binaryEnvelope.slice(0, 16 + metadataLength);
    new DataView(emptyPcm.buffer).setUint32(12, 0, true);
    expect(() => decodeValidationBinaryEnvelope(emptyPcm)).toThrow(
      "Invalid binary envelope PCM length",
    );

    const oddPcm = value.binaryEnvelope.slice(0, -1);
    new DataView(oddPcm.buffer).setUint32(12, pcmLength - 1, true);
    expect(() => decodeValidationBinaryEnvelope(oddPcm)).toThrow(
      "Invalid binary envelope PCM length",
    );
  });

  test("rejects non-canonical base64 and oversized envelopes", () => {
    for (const audio_samples_b64 of ["Y W I =", "-_8="]) {
      expect(() => encodeValidationBinaryEnvelope({ ...value.request, audio_samples_b64 })).toThrow(
        "Binary envelope requires canonical base64 PCM",
      );
    }

    expect(() => decodeValidationBinaryEnvelope(new Uint8Array(1_048_577))).toThrow(
      "Binary envelope exceeds executor body limit",
    );
  });
});

const benchmarkTest = process.env.ENTROS_TRANSPORT_BENCHMARK === "1" ? test : test.skip;

benchmarkTest("reports deterministic serialization measurements", () => {
  const reports = VALIDATION_TRANSPORT_PROFILES.map((profile) => {
    const value = fixture(profile.name);
    const timings: number[] = [];
    JSON.stringify(value.request);

    for (let run = 0; run < SERIALIZATION_RUNS; run += 1) {
      const startedAt = performance.now();
      JSON.stringify(value.request);
      timings.push(performance.now() - startedAt);
    }
    timings.sort((left, right) => left - right);

    return {
      profile: profile.name,
      jsonBytes: value.jsonBytes,
      binaryBytes: value.binaryBytes,
      base64Bytes: value.base64Bytes,
      decodedPcmBytes: value.decodedPcmBytes,
      authorizationDigest: value.authorizationDigestHex,
      serializationP50Ms: percentile(timings, 0.5),
      serializationP95Ms: percentile(timings, 0.95),
    };
  });

  expect(SERIALIZATION_RUNS).toBeGreaterThanOrEqual(100);
  expect(reports.every((report) => report.serializationP95Ms >= report.serializationP50Ms)).toBe(
    true,
  );
  process.stdout.write(
    `${JSON.stringify({
      appVersion: packageMetadata.version,
      nodeVersion: process.version,
      serializationRuns: SERIALIZATION_RUNS,
      maxRssBytes: process.resourceUsage().maxRSS * 1_024,
      fixtures: reports,
    })}\n`,
  );
});
