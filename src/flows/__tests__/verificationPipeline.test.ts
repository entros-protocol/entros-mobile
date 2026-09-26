import { extractFeatures, extractProjectionOneCompatibilityFeatures } from "@/extraction";
import { bigintToBytes32, simhash } from "@/hashing";
import { loadBaseline, persistPreparedBaseline, prepareBaseline } from "@/identity/baseline";
import { generateSolanaProof } from "@/proof/prover";
import { submitVerify } from "@/protocol/submit";
import { resampleCurveTrace } from "@/sensor/curve";
import { encodeAudioAsBase64 } from "@/sensor/encode";
import type { SensorData } from "@/sensor/types";
import { authorizeAndSendValidation } from "@/services/authorizedValidation";
import { validateFeaturesRequest, type ValidateOutcome } from "@/services/executor";

import {
  prepareSingleCapture,
  runVerificationPipeline,
  WalletSession,
  type PipelineInput,
  type ValidationStepResult,
} from "../verificationPipeline";

jest.mock("@/config", () => ({
  config: { relayerUrl: "https://executor.test", relayerApiKey: null, proofManifest: undefined },
  getConnection: jest.fn(),
}));
jest.mock("@/extraction", () => ({
  extractFeatures: jest.fn(),
  extractProjectionOneCompatibilityFeatures: jest.fn(),
}));
jest.mock("@/services/executor", () => {
  const actual = jest.requireActual("@/services/executor");
  return { ...actual, validateFeaturesRequest: jest.fn() };
});
jest.mock("@/services/authorizedValidation", () => ({ authorizeAndSendValidation: jest.fn() }));
jest.mock("@/identity/baseline", () => ({
  loadBaseline: jest.fn(),
  prepareBaseline: jest.fn(),
  persistPreparedBaseline: jest.fn(),
}));
jest.mock("@/proof/prover", () => ({ generateSolanaProof: jest.fn() }));
jest.mock("@/lib/log", () => ({ devWarn: jest.fn() }));
jest.mock("@/protocol/submit", () => ({
  submitVerify: jest.fn(),
  submitReset: jest.fn(),
  submitRebaseline: jest.fn(),
  submitProofIdentityUpgrade: jest.fn(),
}));

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FEATURE_COUNT = 308;

const validateMock = jest.mocked(validateFeaturesRequest);
const authorizeMock = jest.mocked(authorizeAndSendValidation);
const submitVerifyMock = jest.mocked(submitVerify);

function seeded(length: number, seed: number): number[] {
  let state = seed;
  return Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  });
}

function extracted() {
  return {
    raw: seeded(FEATURE_COUNT, 1).map((value) => value * 10),
    normalized: seeded(FEATURE_COUNT, 2),
    f0Contour: [118.5, 121.25, 0],
    accelMagnitude: [0.012, 0.018, 0.02],
  };
}

function capture(): SensorData {
  return {
    audio: {
      pcm: Float32Array.from(seeded(1_600, 3)),
      sampleRate: 16_000,
      nativeSampleRate: 48_000,
      durationMs: 100,
      startedAt: 1_000,
    },
    motion: { samples: [], sampleRate: 0, durationMs: 0, startedAt: 1_000 },
    touch: {
      samples: [],
      durationMs: 0,
      curveTrace: [
        { t: 0, x: 10, y: 20 },
        { t: 40, x: 50, y: 60 },
        { t: 90, x: 80, y: 120 },
      ],
    },
  };
}

const ok: Extract<ValidateOutcome, { kind: "ok" }> = {
  kind: "ok",
  remainingQuota: 4,
  signedReceipt: {
    validator_pubkey_hex: "8c".repeat(32),
    message_hex: "00".repeat(103),
    signature_hex: "ab".repeat(64),
  },
  commitmentHex: "0f".repeat(32),
  saltHex: "01".repeat(32),
  compositeRiskScore: null,
};

function wallet(): WalletSession {
  return new WalletSession(WALLET, "phantom", "token-1", async () => true);
}

const context = (projectionVersion: number, receiptPurpose?: "mint" | "rebaseline" | "reset") => ({
  wallet: wallet(),
  projectionVersion,
  receiptPurpose,
  challenge: { nonce: new Uint8Array(32).fill(9), expiresAtMs: 50_000 },
  isCancelled: () => false,
  signal: new AbortController().signal,
});

beforeEach(() => {
  jest
    .mocked(extractFeatures)
    .mockReset()
    .mockImplementation(async () => extracted());
  jest
    .mocked(extractProjectionOneCompatibilityFeatures)
    .mockReset()
    .mockImplementation(async () => seeded(FEATURE_COUNT, 4));
  validateMock.mockReset();
  authorizeMock.mockReset();
  submitVerifyMock.mockReset();
  jest.mocked(loadBaseline).mockReset();
  jest.mocked(prepareBaseline).mockReset().mockResolvedValue({ serializedEnvelope: "sealed" });
  jest.mocked(persistPreparedBaseline).mockReset().mockResolvedValue(undefined);
  jest.mocked(generateSolanaProof).mockReset();
  Object.defineProperty(globalThis, "__DEV__", { value: false, configurable: true });
});

describe("single capture validation step", () => {
  test("sends the same /validate-features body the processing screen built", async () => {
    const bodies: string[] = [];
    validateMock.mockImplementation(async (body, options) => {
      bodies.push(JSON.stringify(body));
      expect(options).toMatchObject({ deadlineAtMs: 50_000 });
      return ok;
    });
    const captured = capture();
    const audio = encodeAudioAsBase64(captured.audio.pcm);
    const curve = resampleCurveTrace(captured.touch.curveTrace!);
    const single = await prepareSingleCapture(captured, context(1, "mint"));
    const features = extracted();
    const result = await single.validate({
      features: features.raw,
      f0Contour: features.f0Contour,
      accelMagnitude: features.accelMagnitude,
      commitmentNewHex: "ab".repeat(32),
    });
    expect(result).toEqual({ kind: "ok", outcome: ok });

    // Key order and values as the screen serialized them before the pipeline
    // moved: buildValidateFeaturesRequestBody over the capture's inputs.
    expect(bodies).toEqual([
      JSON.stringify({
        features: features.raw,
        projection_version: 1,
        wallet_id: WALLET,
        compatibility_evidence: undefined,
        wallet_authorization: undefined,
        f0_contour: features.f0Contour,
        accel_magnitude: features.accelMagnitude,
        audio_samples_b64: audio,
        audio_sample_rate_hz: 16_000,
        commitment_new_hex: "ab".repeat(32),
        request_receipt: true,
        receipt_purpose: "mint",
        baseline_reset: false,
        curve_trace: curve,
      }),
    ]);
    // The phrase audio is sent once.
    await single.validate({
      features: features.raw,
      f0Contour: features.f0Contour,
      accelMagnitude: features.accelMagnitude,
      commitmentNewHex: "ab".repeat(32),
    });
    expect(JSON.parse(bodies[1]!)).not.toHaveProperty("audio_samples_b64");
  });

  test("authorizes a projection 2 body with the challenge nonce and adopts the rotated token", async () => {
    const context2 = context(2, "rebaseline");
    let signed: Record<string, unknown> = {};
    authorizeMock.mockImplementation(async (args) => {
      signed = JSON.parse(JSON.stringify(args.requestBody));
      expect(args.nonce).toEqual(new Uint8Array(32).fill(9));
      expect(args.expiresAtMs).toBe(50_000);
      return { kind: "sent", outcome: ok, authToken: "token-2" };
    });
    const single = await prepareSingleCapture(capture(), context2);
    const features = extracted();
    await expect(
      single.validate({
        features: features.raw,
        f0Contour: features.f0Contour,
        accelMagnitude: features.accelMagnitude,
        commitmentNewHex: "cd".repeat(32),
      }),
    ).resolves.toEqual({ kind: "ok", outcome: ok });
    expect(signed).toMatchObject({
      projection_version: 2,
      receipt_purpose: "rebaseline",
      compatibility_evidence: {
        projection_version: 1,
        feature_schema_version: 4,
        features: seeded(FEATURE_COUNT, 4),
      },
    });
    expect(context2.wallet.authToken).toBe("token-2");
    expect(validateMock).not.toHaveBeenCalled();

    authorizeMock.mockResolvedValueOnce({ kind: "expired" });
    await expect(
      single.validate({
        features: features.raw,
        f0Contour: [],
        accelMagnitude: [],
        commitmentNewHex: "cd".repeat(32),
      }),
    ).resolves.toEqual({ kind: "drift", bucket: "retry-now" });
  });

  test("passes a rejection through for the screen to route", async () => {
    validateMock.mockResolvedValueOnce({ kind: "soft-reject", reason: "variance_floor" });
    const single = await prepareSingleCapture(capture(), context(1));
    const features = extracted();
    await expect(
      single.validate({
        features: features.raw,
        f0Contour: [],
        accelMagnitude: [],
        commitmentNewHex: "ab".repeat(32),
      }),
    ).resolves.toEqual({
      kind: "failed",
      failure: { kind: "soft-reject", reason: "variance_floor" },
    });
  });
});

function pipelineInput<F>(
  overrides: Partial<PipelineInput<F>> & Pick<PipelineInput<F>, "validate">,
): PipelineInput<F> {
  return {
    wallet: wallet(),
    flowIntent: "verify",
    projectionVersion: 1,
    chainIdentity: null,
    rebaselineRequired: false,
    extracted: extracted(),
    proofNonce: async () => new Uint8Array(32).fill(7),
    isCancelled: () => false,
    onAdvance: jest.fn(),
    devOverride: () => false,
    ...overrides,
  };
}

describe("verification pipeline", () => {
  test("mints with the validator's commitment and receipt, then persists the baseline", async () => {
    submitVerifyMock.mockImplementation(async (_args, onSigned) => {
      onSigned?.();
      return { txSignature: "mint-signature", authToken: "token-1" };
    });
    const input = pipelineInput({
      validate: async (): Promise<ValidationStepResult<never>> => ({ kind: "ok", outcome: ok }),
    });
    const features = input.extracted;
    await expect(runVerificationPipeline(input)).resolves.toEqual({
      kind: "success",
      txSignature: "mint-signature",
    });
    const [args] = submitVerifyMock.mock.calls[0]!;
    expect(args.isFirstVerify).toBe(true);
    expect(args.signedReceipt).toBe(ok.signedReceipt);
    expect(args.commitment).toEqual(bigintToBytes32(BigInt("0x" + ok.commitmentHex!)));
    expect(args.nonce).toBeUndefined();
    expect(input.onAdvance).toHaveBeenCalledTimes(4);
    expect(persistPreparedBaseline).toHaveBeenCalledWith({ serializedEnvelope: "sealed" });
    expect(loadBaseline).not.toHaveBeenCalled();
    // The feature arrays are cleared once the proof scope closes.
    expect(features.raw.every((value) => value === 0)).toBe(true);
  });

  test("an update proves and submits against the nonce the input supplies", async () => {
    const features = extracted();
    const fingerprint = simhash(features.normalized, 1);
    const previous = fingerprint.map((bit, index) => (index < 5 ? 1 - bit : bit));
    jest.mocked(loadBaseline).mockResolvedValue({
      fingerprint: previous,
      salt: "5",
      commitment: "123456789",
      timestamp: 1,
      projectionVersion: 1,
    });
    const proof = { proofBytes: new Uint8Array(256), publicInputs: [] };
    jest.mocked(generateSolanaProof).mockResolvedValue(proof);
    submitVerifyMock.mockResolvedValue({ txSignature: "update-signature", authToken: "token-1" });
    const proofNonce = jest.fn(async () => new Uint8Array(32).fill(7));
    const outcome = await runVerificationPipeline(
      pipelineInput({
        chainIdentity: { projectionVersion: 1 },
        extracted: features,
        proofNonce,
        validate: async (): Promise<ValidationStepResult<never>> => ({
          kind: "ok",
          outcome: { ...ok, signedReceipt: null },
        }),
      }),
    );
    expect(outcome).toEqual({ kind: "success", txSignature: "update-signature" });
    expect(proofNonce).toHaveBeenCalledTimes(1);
    const [args] = submitVerifyMock.mock.calls[0]!;
    expect(args.isFirstVerify).toBe(false);
    expect(args.proof).toBe(proof);
    expect(args.nonce).toEqual(Array.from(new Uint8Array(32).fill(7)));
  });

  test("routes a validation failure without signing and a wallet refusal silently", async () => {
    const failed = await runVerificationPipeline(
      pipelineInput<string>({
        validate: async () => ({ kind: "failed", failure: "session_consumed" }),
      }),
    );
    expect(failed).toEqual({ kind: "validation-failed", failure: "session_consumed" });
    expect(submitVerifyMock).not.toHaveBeenCalled();

    const refusal = new Error("User rejected the request");
    submitVerifyMock.mockRejectedValueOnce(refusal);
    await expect(
      runVerificationPipeline(
        pipelineInput({
          validate: async (): Promise<ValidationStepResult<never>> => ({ kind: "ok", outcome: ok }),
        }),
      ),
    ).resolves.toEqual({ kind: "wallet-rejected" });
  });

  test("stops before signing when the screen is gone", async () => {
    let cancelled = false;
    const outcome = await runVerificationPipeline(
      pipelineInput({
        isCancelled: () => cancelled,
        validate: async (): Promise<ValidationStepResult<never>> => {
          cancelled = true;
          return { kind: "ok", outcome: ok };
        },
      }),
    );
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(submitVerifyMock).not.toHaveBeenCalled();
  });
});
