// A paired session's finalize: the analysis signal, feature extraction, the
// optional Play Integrity token, the `/validate-session` step and the receipt
// check that runs before any wallet prompt.
//
// Features read `normalizeCaptureRMS(concat(decodePcm16(segments)))`, rebuilt
// from the committed bytes, so the validator reproduces the same signal. The
// joined session is levelled once. No round is levelled on its own.
//
// PRIVACY:
// - Segment audio leaves the device in the finalize body, and the validation
//   service must not persist it. A resend carries the same body.
// - Motion and touch never leave the device. Their features, the F0 contour
//   and the acceleration contour do.
// - A Play Integrity token carries a device integrity verdict and no device
//   identifier. It is stronger app and device integrity evidence bound to this
//   request. It does not prove a person, a microphone or a touchscreen.

import { bytesToHex } from "@noble/hashes/utils.js";
import { PublicKey } from "@solana/web3.js";

import { extractFeatures, MIN_AUDIO_SAMPLES } from "@/extraction";
import type { ExtractedFeatures } from "@/extraction";
import { devWarn } from "@/lib/log";
import {
  analysisSignal,
  attestationDigest,
  buildFinalizeBody,
  checkFinalizeSuccess,
  computeFinalDigest,
  PAIRED_PROJECTION_VERSION,
  PAIRED_PROTOCOL_VERSION,
  PAIRED_SAMPLE_RATE,
  type PairedCaptureTiming,
} from "@/paired";
import { describeCaptureLevel } from "@/sensor/audioNormalization";
import type { MotionCapture, SensorData } from "@/sensor/types";
import { fetchChallenge } from "@/services/executor";
import type { PairedFailure } from "@/services/pairedErrors";
import { finalizePairedSession } from "@/services/pairedExecutor";
import type { ClientSignals } from "@/services/validationAuthorization";
import type { PairedSessionHandoff } from "@/state/pairedSessionBuffer";
import type { VerifyIntent } from "@/state/types";

import type { ReceiptPurposeName, ValidationStep, WalletSession } from "./verificationPipeline";

/** The runtime is not a browser, so there is no automation surface to report. */
const NATIVE_CLIENT_SIGNALS: ClientSignals = {
  v: 1,
  env: "non-browser",
  automation: { webdriver: false, tells: [] },
};

export interface PairedVerificationContext {
  wallet: WalletSession;
  flowIntent: VerifyIntent;
  receiptPurpose: ReceiptPurposeName | undefined;
  isCancelled(): boolean;
  signal: AbortSignal;
  /** A Play Integrity token over a lowercase hex digest. Resolves null on any failure. */
  attestationToken(requestHashHex: string): Promise<string | null>;
  /** Runs as the finalize request goes out. From then on its resends watch the session's end. */
  onFinalize?(): void;
  /** Monotonic clock the session's end counts on. */
  now?: () => number;
  /** Fetches the nonce an update proof binds. Defaults to `GET /challenge`. */
  fetchProofNonce?: (walletAddress: string) => Promise<Uint8Array>;
}

export type PreparedPairedVerification =
  | {
      kind: "ready";
      extracted: ExtractedFeatures;
      validate: ValidationStep<PairedFailure>;
      /** A paired session has no single-capture nonce, so an update fetches one. */
      proofNonce(): Promise<Uint8Array>;
      release(): void;
    }
  | { kind: "no-voice" };

/** Diagnostic scalars for the executor and validator logs. Never samples. */
function describePairedCaptureTiming(
  joined: Float32Array,
  motion: MotionCapture,
  audioWindowMs: number,
): PairedCaptureTiming {
  const level = describeCaptureLevel(joined);
  const first = motion.samples[0];
  const last = motion.samples[motion.samples.length - 1];
  const round = (value: number, digits: number) =>
    Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
  return {
    v: 1,
    motion_samples: motion.samples.length,
    motion_span_ms: first && last ? round(last.t - first.t, 2) : 0,
    audio_window_ms: round(audioWindowMs, 2),
    audio_input_rms: round(level.rms, 6),
    audio_input_peak: round(level.peak, 6),
    audio_normalization_gain: round(level.gain, 3),
    audio_gain_clipped: level.gainClipped,
  };
}

/**
 * Extracts the session's features and builds its finalize step. The token
 * request starts before extraction and runs beside it. Attestation never
 * blocks or fails a verification: without a token the request goes out
 * without one.
 */
export async function preparePairedVerification(
  handoff: PairedSessionHandoff,
  context: PairedVerificationContext,
): Promise<PreparedPairedVerification> {
  const { rounds, motion, touch } = handoff;
  const { open, commits } = rounds;
  const now = context.now ?? (() => performance.now());
  const fetchProofNonce =
    context.fetchProofNonce ?? (async (address: string) => (await fetchChallenge(address)).nonce);

  const finalDigest = computeFinalDigest(open, commits);
  const walletBytes = new PublicKey(context.wallet.address).toBytes();
  const requestHash = bytesToHex(
    attestationDigest({
      protocolVersion: PAIRED_PROTOCOL_VERSION,
      sessionNonce: open.sessionNonce,
      attemptBinding: open.attemptBinding,
      finalDigest,
      projectionVersion: PAIRED_PROJECTION_VERSION,
    }),
  );
  const tokenRequest = context.attestationToken(requestHash).catch(() => null);

  const { joined, signal: pcm } = analysisSignal(commits.map((commit) => commit.segment));
  if (pcm.length < MIN_AUDIO_SAMPLES) return { kind: "no-voice" };
  const audioWindowMs = Math.max(0, rounds.audioEndedAtMs - rounds.audioStartedAtMs);
  const sensorData: SensorData = {
    audio: {
      pcm,
      sampleRate: PAIRED_SAMPLE_RATE,
      nativeSampleRate: rounds.nativeSampleRate,
      durationMs: audioWindowMs,
      startedAt: rounds.audioStartedAtMs,
    },
    motion,
    touch,
  };
  const captureTiming = describePairedCaptureTiming(joined, motion, audioWindowMs);
  const extracted = await extractFeatures(sensorData, PAIRED_PROJECTION_VERSION);
  const token = await tokenRequest;
  devWarn(`[Entros] paired attestation token=${token ? "present" : "absent"}`);

  let freshNonce: Promise<Uint8Array> | null = null;
  let released = false;

  const validate: ValidationStep<PairedFailure> = async ({
    features,
    f0Contour,
    accelMagnitude,
  }) => {
    if (released || context.isCancelled()) return { kind: "cancelled" };
    const body = buildFinalizeBody({
      open,
      commits,
      features,
      f0Contour,
      accelMagnitude,
      captureTiming,
      clientSignals: NATIVE_CLIENT_SIGNALS,
      baselineReset: context.flowIntent === "reset",
      ...(token ? { attestationToken: token } : {}),
    });
    context.onFinalize?.();
    const outcome = await finalizePairedSession(body, {
      sessionEndsAtMs: rounds.sessionEndsAtMs,
      signal: context.signal,
      now,
    });
    body.segments.length = 0;
    if (context.isCancelled()) return { kind: "cancelled" };
    if (outcome.kind === "rejected") return { kind: "failed", failure: outcome.failure };

    const checked = checkFinalizeSuccess(outcome.body, {
      purpose: context.receiptPurpose,
      wallet: walletBytes,
      finalDigest,
    });
    if (typeof checked === "string") return { kind: "failed", failure: { detail: checked } };
    devWarn(`[Entros] /validate-session ok tier=${checked.assuranceTier ?? "none"}`);
    return {
      kind: "ok",
      outcome: {
        kind: "ok",
        remainingQuota: checked.remainingQuota,
        signedReceipt: checked.signedReceipt,
        commitmentHex: checked.commitmentHex,
        saltHex: checked.saltHex,
        compositeRiskScore: null,
      },
    };
  };

  return {
    kind: "ready",
    extracted,
    validate,
    proofNonce() {
      freshNonce ??= fetchProofNonce(context.wallet.address);
      return freshNonce;
    },
    release() {
      released = true;
      commits.forEach((commit) => commit.segment.fill(0));
    },
  };
}
