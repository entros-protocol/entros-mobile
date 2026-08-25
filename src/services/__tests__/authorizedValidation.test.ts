import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";

import type { WalletKind } from "@/state/types";
import type { AuthTokenRotationHandler } from "@/wallet/mwa";

import type { ValidateFeaturesRequestBody, ValidateOutcome } from "../executor";
import { authorizeAndSendValidation } from "../authorizedValidation";
import {
  buildValidationAuthorizationMessage,
  buildValidationRequestDigest,
} from "../validationAuthorization";

jest.mock("@/wallet/mwa", () => ({ signMessage: jest.fn() }));
jest.mock("@/config", () => ({ config: {} }));

const nonce = new Uint8Array(32).fill(7);
const privateKey = new Uint8Array(32).fill(9);
const publicKey = ed25519.getPublicKey(privateKey);
const walletAddress = new PublicKey(publicKey).toBase58();
const okOutcome: ValidateOutcome = {
  kind: "ok",
  remainingQuota: 4,
  signedReceipt: null,
  commitmentHex: null,
  saltHex: null,
  compositeRiskScore: null,
};

function requestBody(): ValidateFeaturesRequestBody {
  return {
    baseline_reset: false,
    features: [1, 2, 3],
    compatibility_evidence: {
      projection_version: 1,
      feature_schema_version: 4,
      features: [4, 5, 6],
    },
    f0_contour: [100, 101],
    accel_magnitude: [0.5, 0.75],
    audio_samples_b64: "AQID",
    audio_sample_rate_hz: 16_000,
    wallet_id: walletAddress,
    projection_version: 2,
    request_receipt: true,
    receipt_purpose: "mint",
  };
}

describe("authorized projection 2 validation", () => {
  test("signs the exact serialized verdict inputs before transport", async () => {
    const body = requestBody();
    const events: string[] = [];
    let wireBody = "";
    const signMessage = jest.fn(
      async (
        _authToken: string,
        message: Uint8Array,
        _expectedAddress: string,
        _walletKind?: WalletKind | null,
        _timeoutMs?: number,
        onRotated?: AuthTokenRotationHandler,
      ) => {
        await onRotated?.("rotated-token");
        events.push("signed");
        return { signature: ed25519.sign(message, privateKey), authToken: "rotated-token" };
      },
    );
    const sendValidation = jest.fn(async (request: ValidateFeaturesRequestBody) => {
      events.push("sent");
      wireBody = JSON.stringify(request);
      return okOutcome;
    });

    await expect(
      authorizeAndSendValidation({
        requestBody: body,
        nonce,
        expiresAtMs: 10_000,
        walletAddress,
        walletKind: "phantom",
        authToken: "old-token",
        onAuthTokenRotated: async (token) => {
          expect(token).toBe("rotated-token");
          events.push("persisted");
        },
        isCancelled: () => false,
        now: () => 1_000,
        signMessage,
        sendValidation,
      }),
    ).resolves.toEqual({ kind: "sent", outcome: okOutcome, authToken: "rotated-token" });

    expect(events).toEqual(["persisted", "signed", "sent"]);
    const transmitted = JSON.parse(wireBody) as ValidateFeaturesRequestBody;
    const authorization = transmitted.wallet_authorization;
    expect(authorization?.nonce).toEqual(Array.from(nonce));
    const transmittedSignature = Uint8Array.from(
      Buffer.from(authorization?.signature_hex ?? "", "hex"),
    );
    const transmittedMessage = new TextEncoder().encode(
      buildValidationAuthorizationMessage(
        transmitted.wallet_id,
        nonce,
        transmitted.projection_version,
        buildValidationRequestDigest(transmitted),
      ),
    );
    expect(ed25519.verify(transmittedSignature, transmittedMessage, publicKey)).toBe(true);
  });

  test("does not send after cancellation while the wallet is open", async () => {
    let cancelled = false;
    const sendValidation = jest.fn(async () => okOutcome);
    const signMessage = jest.fn(async () => {
      cancelled = true;
      return { signature: new Uint8Array(64), authToken: "rotated-token" };
    });

    await expect(
      authorizeAndSendValidation({
        requestBody: requestBody(),
        nonce,
        expiresAtMs: 10_000,
        walletAddress,
        walletKind: "phantom",
        authToken: "old-token",
        onAuthTokenRotated: jest.fn(),
        isCancelled: () => cancelled,
        now: () => 1_000,
        signMessage,
        sendValidation,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(sendValidation).not.toHaveBeenCalled();
  });

  test("does not send when the challenge expires during signing", async () => {
    const now = jest.fn().mockReturnValueOnce(1_000).mockReturnValue(2_001);
    const sendValidation = jest.fn(async () => okOutcome);

    await expect(
      authorizeAndSendValidation({
        requestBody: requestBody(),
        nonce,
        expiresAtMs: 2_000,
        walletAddress,
        walletKind: "phantom",
        authToken: "old-token",
        onAuthTokenRotated: jest.fn(),
        isCancelled: () => false,
        now,
        signMessage: jest.fn(async () => ({
          signature: new Uint8Array(64),
          authToken: "rotated-token",
        })),
        sendValidation,
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(sendValidation).not.toHaveBeenCalled();
  });
});
