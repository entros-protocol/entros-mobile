// Verification processing screen. It extracts features, validates the capture,
// encrypts the baseline, generates any required proof, and submits through MWA.
// The single capture posts to /validate-features. A paired session posts its
// committed segments to /validate-session. Both then share one pipeline in
// src/flows/verificationPipeline.ts.
//
// PRIVACY:
// - Captured SensorData is taken once from the buffer and dropped the moment
//   extraction returns and the audio is encoded for validation.
//   The typed arrays are then eligible for garbage collection.
// - A paired session's segments are taken once from their buffer and leave
//   the device only in the finalize request, which a resend repeats unchanged.
// - Phrase audio is transient. The validation service must not persist it.
// - See verificationPipeline.ts for the fingerprint and logging rules.

import { useRouter } from "expo-router";
import { useEffect, useReducer } from "react";
import { StyleSheet, View } from "react-native";

import { ProcessingStage } from "@/components/pulse/ProcessingStage";
import { Screen } from "@/components/primitives/Screen";
import { MIN_AUDIO_SAMPLES } from "@/extraction";
import { readChainContext } from "@/flows/chainContext";
import { pairedFailureScreen } from "@/flows/pairedFailure";
import { preparePairedVerification } from "@/flows/pairedVerification";
import {
  prepareSingleCapture,
  runVerificationPipeline,
  WalletSession,
  type PipelineOutcome,
} from "@/flows/verificationPipeline";
import { initialContext, reduce, stageCopy } from "@/flows/verifyMachine";
import { devWarn } from "@/lib/log";
import { PAIRED_PROJECTION_VERSION } from "@/paired";
import { ValidateOutcome } from "@/services/executor";
import type { PairedFailure } from "@/services/pairedErrors";
import { tokenFor } from "@/services/playIntegrity";
import type { VerificationReason } from "@/services/reasons";
import { useAppState } from "@/state/AppState";
import { clearCapture, takeCapture } from "@/state/captureBuffer";
import { clearChallenge, peekChallenge, takeChallenge } from "@/state/challengeBuffer";
import { clearCommitment } from "@/state/commitmentBuffer";
import {
  clearPairedSession,
  takePairedSession,
  type PairedSessionHandoff,
} from "@/state/pairedSessionBuffer";
import { clearProof } from "@/state/proofBuffer";
import { FailureBucket } from "@/state/types";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

export default function Processing() {
  const router = useRouter();
  const { palette } = useTheme();
  const {
    connection,
    dev,
    flow,
    verify,
    resetComplete,
    fail,
    setForceOutcome,
    setFlowIntent,
    updateAuthToken,
  } = useAppState();
  const [ctx, dispatch] = useReducer(reduce, { ...initialContext, state: "extracting" });

  useEffect(() => {
    let cancelled = false;
    const validationController = new AbortController();
    // Ends a paired session at its end unless its finalize goes out first.
    let sessionExpiry: ReturnType<typeof setTimeout> | undefined;
    const stopSessionExpiry = () => {
      clearTimeout(sessionExpiry);
      sessionExpiry = undefined;
    };

    // Every exit runs once. Leaving also stops the pipeline and the session
    // expiry, so nothing routes a second time before the screen unmounts.
    const leave = (): boolean => {
      if (cancelled) return false;
      cancelled = true;
      stopSessionExpiry();
      return true;
    };

    // Snapshot wallet credentials at mount-time. /verify/intro already
    // gates on this, but a parallel disconnect (wallet menu) would
    // otherwise surface a confusing on-chain rejection later. We need
    // all three (address, kind, authToken) for MWA's signAndSendTransaction.
    const walletId = connection.address;
    const walletKind = connection.wallet;
    const initialAuthToken = connection.authToken;
    if (!walletId || !walletKind || !initialAuthToken) {
      router.replace("/connect");
      return;
    }
    const wallet = new WalletSession(walletId, walletKind, initialAuthToken, updateAuthToken);
    const flowIntent = flow.intent;

    const failOut = (bucket: FailureBucket, message?: string) => {
      if (!leave()) return;
      fail(bucket);
      setForceOutcome(null);
      router.replace({
        pathname: "/verify/failure",
        params: message ? { bucket, message } : { bucket },
      });
    };

    // Like failOut but does NOT record a failed VerificationEvent in history —
    // for pre-proof, capture-quality retries (Hamming drift / replay floor) that
    // never reached the chain. Matches the soft-reject philosophy: a transient
    // "try again" is not a verification failure. The failure screen is still
    // driven entirely by the bucket param.
    const failOutNoLog = (bucket: FailureBucket) => {
      if (!leave()) return;
      setForceOutcome(null);
      router.replace({ pathname: "/verify/failure", params: { bucket } });
    };

    // Soft-rejects don't count against the verification history (matches
    // the web flow's soft_failed transition) — they're transient retries
    // surfaced through a friendlier UX. Hard buckets above use `failOut`
    // which DOES log to history.
    const routeSoftReject = (reason: VerificationReason) => {
      if (!leave()) return;
      setForceOutcome(null);
      router.replace({
        pathname: "/verify/failure",
        params: { bucket: "soft", reason },
      });
    };

    const routeRateLimited = (retryAfterSec: number) => {
      if (!leave()) return;
      fail("rate-limited");
      setForceOutcome(null);
      router.replace({
        pathname: "/verify/failure",
        params: { bucket: "rate-limited", retryAfter: String(retryAfterSec) },
      });
    };

    const routeFromValidateOutcome = (outcome: Exclude<ValidateOutcome, { kind: "ok" }>) => {
      switch (outcome.kind) {
        case "soft-reject":
          devWarn(`[Entros] /validate-features rejected reason=${outcome.reason}`);
          routeSoftReject(outcome.reason);
          return;
        case "rate-limited":
          devWarn(`[Entros] /validate-features rate-limited retryAfter=${outcome.retryAfterSec}s`);
          routeRateLimited(outcome.retryAfterSec);
          return;
        case "timeout":
          // We aborted the request ourselves, so no verdict exists to record.
          // Route to the transient-retry surface rather than "relayer not
          // connected", and skip the history write for the same reason the
          // taxonomy marks validation_timeout client-origin: nothing was
          // judged, so nothing failed.
          devWarn("[Entros] /validate-features timed out");
          failOutNoLog("retry-now");
          return;
        case "service-down":
          devWarn(`[Entros] /validate-features service-down: ${outcome.message}`);
          failOut("relayer-down");
          return;
        case "payload-too-large":
          // The client assembled a body the executor refused to read. Resending
          // it earns the same rejection, so this is report-and-stop rather than
          // a retry. The diagnostics code is what moves it forward.
          devWarn("[Entros] /validate-features rejected (payload-too-large)");
          failOut("report-bug", "payload_too_large");
          return;
        case "quota-exhausted":
        case "unauthorized":
        case "hard-reject":
        case "unknown":
          devWarn(`[Entros] /validate-features rejected (${outcome.kind})`);
          failOut("generic");
          return;
      }
    };

    const routePairedFailure = (failure: PairedFailure) => {
      if (!leave()) return;
      devWarn(
        `[Entros] paired session failed reason=${failure.reason ?? "none"} status=${failure.status ?? "none"}`,
      );
      const screen = pairedFailureScreen(failure);
      if (screen.record) fail(screen.record);
      setForceOutcome(null);
      router.replace({ pathname: "/verify/failure", params: screen.params });
    };

    // Dev panel override: lets UI testers skip on-chain submission and
    // exercise the success / failure routes directly. Returns true if a
    // dev override fired, false to continue with the real flow.
    const handleDevOverride = (): boolean => {
      const force = dev.forceOutcome;
      if (force === "success") {
        if (!leave()) return true;
        const fakeTxSig = `dev${Math.random().toString(36).slice(2, 10)}…fake`;
        verify(2, fakeTxSig);
        setForceOutcome(null);
        router.replace("/verify/success");
        return true;
      }
      if (force) {
        failOut(force);
        return true;
      }
      return false;
    };

    const routePipelineOutcome = <F,>(
      outcome: PipelineOutcome<F>,
      routeValidationFailure: (failure: F) => void,
    ) => {
      if (outcome.kind === "cancelled") return;
      switch (outcome.kind) {
        case "validation-failed":
          routeValidationFailure(outcome.failure);
          return;
        case "retry":
          failOutNoLog(outcome.bucket);
          return;
        case "failed":
          failOut(outcome.bucket, outcome.message);
          return;
        case "wallet-rejected":
          if (!leave()) return;
          setForceOutcome(null);
          router.replace("/verify/intro");
          return;
        case "success":
          if (!leave()) return;
          // Reset the verify-flow intent so the NEXT cycle is a normal
          // verify by default. Failure path leaves the intent intact so a
          // retry stays on the reset path.
          if (flowIntent === "reset") {
            setFlowIntent("verify");
            resetComplete(outcome.txSignature);
          } else {
            verify(2, outcome.txSignature);
          }
          setForceOutcome(null);
          router.replace("/verify/success");
          return;
      }
    };

    /** Reads the chain once. Routes and returns null when it cannot proceed. */
    const readChain = async () => {
      const result = await readChainContext(walletId, flowIntent);
      switch (result.kind) {
        case "unreadable":
          failOut("retry-now", result.message);
          return null;
        case "unsupported-identity":
          failOut("report-bug", "The identity projection version is not supported.");
          return null;
        case "ok":
          return result.chain;
      }
    };

    // Process one captured sample through validation and on-chain submission.
    const runVerify = async () => {
      let captured: ReturnType<typeof takeCapture> = takeCapture();
      if (!captured) {
        // Direct nav (e.g. dev refresh) lands here without a capture buffer.
        // Send the user back to /verify/intro to start a fresh cycle.
        router.replace("/verify/intro");
        return;
      }

      try {
        if (captured.audio.pcm.length < MIN_AUDIO_SAMPLES) {
          failOut(
            "generic",
            "No voice data detected. Please speak the phrase clearly during capture.",
          );
          return;
        }

        const chain = await readChain();
        if (!chain) return;
        const { projectionVersion } = chain;
        const challenge = peekChallenge();
        if (!challenge) {
          failOut("retry-now", "The server challenge is missing. Start a new capture.");
          return;
        }
        if (challenge.projectionVersion !== projectionVersion) {
          failOut("retry-now", "The protocol projection changed during capture. Start again.");
          return;
        }
        if (performance.now() >= challenge.expiresAtMs) {
          failOut("retry-now", "The server challenge expired. Start a new capture.");
          return;
        }

        const single = await prepareSingleCapture(captured, {
          wallet,
          projectionVersion,
          receiptPurpose: chain.receiptPurpose,
          challenge,
          isCancelled: () => cancelled,
          signal: validationController.signal,
        });
        // Drop the closure ref to the raw sensor buffers — the four largest
        // typed arrays (~768KB audio + motion + touch) become GC-eligible
        // immediately instead of living until submission finishes.
        captured = null;

        const outcome = await runVerificationPipeline({
          wallet,
          flowIntent,
          projectionVersion,
          chainIdentity: chain.chainIdentity,
          rebaselineRequired: chain.rebaselineRequired,
          extracted: single.extracted,
          validate: single.validate,
          proofNonce: async () => challenge.nonce,
          isCancelled: () => cancelled,
          onAdvance: () => dispatch({ type: "advance" }),
          devOverride: handleDevOverride,
          beforeSigning: () => {
            takeChallenge();
          },
          release: single.release,
        });
        routePipelineOutcome(outcome, routeFromValidateOutcome);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Verification failed.";
        failOut("generic", message);
      }
    };

    // Finalize a paired session whose three rounds the server accepted.
    const runPaired = async (handoff: PairedSessionHandoff) => {
      // The session ends at the end the server last reported unless the
      // finalize request goes out first.
      sessionExpiry = setTimeout(
        () => {
          sessionExpiry = undefined;
          routePairedFailure({ reason: "session_expired" });
          validationController.abort();
        },
        Math.max(0, handoff.rounds.sessionEndsAtMs - performance.now()),
      );
      try {
        const chain = await readChain();
        if (!chain) return;
        const { projectionVersion } = chain;
        if (projectionVersion !== PAIRED_PROJECTION_VERSION) {
          routePairedFailure({ reason: "projection_not_supported" });
          return;
        }

        const paired = await preparePairedVerification(handoff, {
          wallet,
          flowIntent,
          receiptPurpose: chain.receiptPurpose,
          isCancelled: () => cancelled,
          signal: validationController.signal,
          attestationToken: (requestHashHex) => tokenFor(requestHashHex),
          onFinalize: stopSessionExpiry,
        });
        if (paired.kind === "no-voice") {
          failOut(
            "generic",
            "No voice data detected. Please say each word clearly during the rounds.",
          );
          return;
        }

        const outcome = await runVerificationPipeline({
          wallet,
          flowIntent,
          projectionVersion,
          chainIdentity: chain.chainIdentity,
          rebaselineRequired: chain.rebaselineRequired,
          extracted: paired.extracted,
          validate: paired.validate,
          proofNonce: paired.proofNonce,
          isCancelled: () => cancelled,
          onAdvance: () => dispatch({ type: "advance" }),
          devOverride: handleDevOverride,
          release: paired.release,
        });
        routePipelineOutcome(outcome, routePairedFailure);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Verification failed.";
        failOut("generic", message);
      }
    };

    const pairedSession = takePairedSession();
    if (pairedSession) void runPaired(pairedSession);
    else void runVerify();
    return () => {
      cancelled = true;
      stopSessionExpiry();
      validationController.abort();
      // Defence-in-depth: clear every handoff slot if the screen unmounts
      // mid-flow (back nav, app suspend, etc.). The next verify cycle starts
      // from a known-empty state.
      clearCapture();
      clearPairedSession();
      clearCommitment();
      clearChallenge();
      clearProof();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ctx.state drives the display; the reducer linearly advances
  // extracting → validating → computing → signing → submitting → success.
  const display = stageCopy[ctx.state] ?? stageCopy.extracting;

  return (
    <Screen>
      <View style={styles.wrap}>
        <ProcessingStage
          title={display?.title ?? "Working"}
          subtitle={display?.subtitle}
          spinnerColor={display?.spinnerColor === "purple" ? palette.solanaPurple : palette.accent}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: spacing.hero },
});
