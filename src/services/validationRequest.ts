import type { CurveTraceOutline } from "@/sensor/types";

import type {
  ProjectionCompatibilityEvidence,
  ValidationDigestRequest,
  WalletAuthorization,
} from "./validationAuthorization";

export interface ValidateInput {
  features: number[];
  projectionVersion: number;
  walletId: string;
  f0Contour?: number[];
  accelMagnitude?: number[];
  audioSamplesB64?: string;
  audioSampleRateHz?: number;
  /** Lowercase 64-character hex of the 32-byte Poseidon commitment. */
  commitmentNewHex?: string;
  receiptPurpose?: "mint" | "rebaseline" | "reset";
  compatibilityEvidence?: ProjectionCompatibilityEvidence;
  walletAuthorization?: WalletAuthorization;
  curveTrace?: CurveTraceOutline;
}

export interface ValidateFeaturesRequestBody extends ValidationDigestRequest {
  wallet_id: string;
  projection_version: number;
  wallet_authorization?: WalletAuthorization;
  commitment_new_hex?: string;
  request_receipt: boolean;
  receipt_purpose?: "mint" | "rebaseline" | "reset";
  curve_trace?: CurveTraceOutline;
}

export function buildValidateFeaturesRequestBody(
  input: ValidateInput,
): ValidateFeaturesRequestBody {
  return {
    features: input.features,
    projection_version: input.projectionVersion,
    wallet_id: input.walletId,
    compatibility_evidence: input.compatibilityEvidence,
    wallet_authorization: input.walletAuthorization,
    f0_contour: input.f0Contour,
    accel_magnitude: input.accelMagnitude,
    audio_samples_b64: input.audioSamplesB64,
    audio_sample_rate_hz: input.audioSampleRateHz,
    commitment_new_hex: input.commitmentNewHex,
    request_receipt: input.receiptPurpose !== undefined,
    receipt_purpose: input.receiptPurpose,
    baseline_reset: input.receiptPurpose === "reset",
    curve_trace: input.curveTrace,
  };
}
