import { ed25519 } from "@noble/curves/ed25519";

import {
  buildValidationAuthorizationMessage,
  buildValidationRequestDigest,
  bytesToHex,
  type ValidationDigestRequest,
} from "../validationAuthorization";

function goldenRequest(): ValidationDigestRequest {
  return {
    baseline_reset: true,
    features: [0, -0, 1.25],
    compatibility_evidence: {
      projection_version: 1,
      feature_schema_version: 4,
      features: [-0, 2.5],
    },
    f0_contour: [-1, 0.5],
    accel_magnitude: [0.25],
    audio_samples_b64: "AQID",
    audio_sample_rate_hz: 16_000,
    client_signals: {
      v: 1,
      env: "browser",
      automation: { webdriver: true, tells: ["selenium", "playwright"] },
      capture: { virtual_device: false, flatness: 0.125, centroid: 2_400 },
    },
    study: {
      token: "study-token",
      record_id: "00112233445566778899aabbccddeeff",
      capture_class: "web-mobile",
      feature_schema_version: 5,
      projection_version: 2,
    },
  };
}

describe("projection 2 validation authorization", () => {
  test("matches the executor digest and message fixture byte for byte", () => {
    const digest = buildValidationRequestDigest(goldenRequest());
    expect(bytesToHex(digest)).toBe(
      "a629314bf11f266689983f629f55c299789c9fca387e34593a8d323661d5f21a",
    );
    expect(
      buildValidationAuthorizationMessage(
        "11111111111111111111111111111111",
        new Uint8Array(32).fill(0x5a),
        2,
        digest,
      ),
    ).toBe(
      [
        "Entros-Validate-v1",
        "wallet:11111111111111111111111111111111",
        `nonce:${"5a".repeat(32)}`,
        "projection:2",
        "request_sha256:a629314bf11f266689983f629f55c299789c9fca387e34593a8d323661d5f21a",
      ].join("\n"),
    );
  });

  test("normalizes negative zero", () => {
    const negative = goldenRequest();
    const positive = goldenRequest();
    negative.features[0] = -0;
    positive.features[0] = 0;
    negative.compatibility_evidence!.features[0] = -0;
    positive.compatibility_evidence!.features[0] = 0;
    expect(buildValidationRequestDigest(negative)).toEqual(buildValidationRequestDigest(positive));
  });

  test("binds signature bytes to the nonce and request", () => {
    const privateKey = new Uint8Array(32).fill(7);
    const publicKey = ed25519.getPublicKey(privateKey);
    const nonce = new Uint8Array(32).fill(0x33);
    const request = goldenRequest();
    const message = new TextEncoder().encode(
      buildValidationAuthorizationMessage(
        "11111111111111111111111111111111",
        nonce,
        2,
        buildValidationRequestDigest(request),
      ),
    );
    const signature = ed25519.sign(message, privateKey);
    expect(ed25519.verify(signature, message, publicKey)).toBe(true);
    request.features[0] = 9;
    const tampered = new TextEncoder().encode(
      buildValidationAuthorizationMessage(
        "11111111111111111111111111111111",
        nonce,
        2,
        buildValidationRequestDigest(request),
      ),
    );
    expect(ed25519.verify(signature, tampered, publicKey)).toBe(false);
  });
});
