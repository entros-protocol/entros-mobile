import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";

import { AlertIcon, RefreshIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { Countdown } from "@/components/primitives/Countdown";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { ValidateReason } from "@/services/executor";
import { useAppState } from "@/state/AppState";
import { FailureBucket } from "@/state/types";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

// Soft-reject hint dictionary, keyed by the validator's safe_label set
// (entros-validation/src/types.rs:99-109). Mirrored byte-for-byte from
// entros.io/src/components/verify/step-views.tsx:108-117 — drift in either
// direction = a reason either escapes to hard-fail (annoying) or slips
// into soft-fail without a hint (confusing). The Record<ValidateReason, …>
// type pins exhaustivity: adding a fifth ValidateReason without updating
// this table is a TS error.
const SOFT_HINT: Record<ValidateReason, string> = {
  variance_floor: "Your signals were a bit flat. Try moving more and speaking with normal volume.",
  entropy_bounds: "Your gestures and speech were a bit too uniform. Try varying both naturally.",
  temporal_coupling_low: "Speak and move at the same time—they were a bit out of sync.",
  phrase_content_mismatch: "Read the phrase clearly at a normal pace, exactly as shown.",
};
const SOFT_HINT_FALLBACK =
  "Something didn't come through cleanly. Give it another shot with natural movement and clear speech.";

/** Buckets surfaced on the danger-toned hard-failure branch. The cyan-toned
 *  retry branch and report-bug branch are handled separately below. */
type HardBucket =
  | "relayer-down"
  | "baseline-missing"
  | "insufficient-funds"
  | "validator-mismatch"
  | "generic";

const hardBucketCopy: Record<
  HardBucket,
  { title: string; subtitle: string; primary: string; secondary?: string }
> = {
  "relayer-down": {
    title: "Relayer not connected",
    subtitle: "Try again in a moment, or check your network.",
    primary: "Try again",
  },
  "baseline-missing": {
    title: "Baseline missing on this device",
    subtitle: "Re-enroll to mint a fresh anchor.",
    primary: "Reset baseline",
    secondary: "Cancel",
  },
  "insufficient-funds": {
    title: "Not enough SOL",
    subtitle: "Add at least 0.01 SOL to this wallet to cover the verification fee, then try again.",
    primary: "Try again",
    secondary: "Cancel",
  },
  "validator-mismatch": {
    title: "Validation service is updating",
    subtitle: "The validator on this network is rotating its signing key. Try again shortly.",
    primary: "Try again",
    secondary: "Cancel",
  },
  generic: {
    title: "Verification failed",
    subtitle: "Something went wrong. Try again, or come back in a few minutes.",
    primary: "Try again",
    secondary: "Cancel",
  },
};

/** Every FailureBucket value, kept in sync with the type union in
 *  src/state/types.ts. Used to validate the screen's `bucket` param at
 *  runtime — params come from the URL/deeplink layer and TypeScript can't
 *  prove they conform without a runtime check. Adding a new bucket without
 *  updating this set means malformed deeplinks land on "generic" silently;
 *  the `Record<FailureBucket, ...>` types below force exhaustivity at
 *  compile-time so the failure mode is contained. */
const ALL_FAILURE_BUCKETS: ReadonlySet<FailureBucket> = new Set<FailureBucket>([
  "relayer-down",
  "baseline-missing",
  "rate-limited",
  "chain-rate-limited",
  "insufficient-funds",
  "validator-mismatch",
  "retry-now",
  "report-bug",
  "generic",
]);

/** Buckets surfaced on the cyan-toned retry branch — transient or
 *  cooldown-windowed failures the user can recover from without protocol
 *  intervention. `allowsImmediateRetry=false` for buckets where the wait
 *  is large and a "Try again" CTA would be misleading (e.g. the on-chain
 *  reset cooldown is 7 days). */
type RetryBucket = "rate-limited" | "chain-rate-limited" | "retry-now";
const RETRY_BUCKETS = new Set<FailureBucket>(["rate-limited", "chain-rate-limited", "retry-now"]);

const retryBucketConfig: Record<
  RetryBucket,
  {
    label: string;
    title: string;
    /** Used when `retryAfter` > 0 and the countdown is ticking. The countdown
     *  text is rendered in-line between this prefix and the suffix. */
    countdownPrefix: string;
    countdownSuffix: string;
    /** Used when `retryAfter` <= 0 or the countdown has expired. */
    settledSubtitle: string;
    /** When false, no "Try again" CTA is rendered — only "OK" — so the
     *  user doesn't tap into another guaranteed failure. */
    allowsImmediateRetry: boolean;
  }
> = {
  "rate-limited": {
    label: "RATE LIMITED",
    title: "Too many attempts",
    countdownPrefix: "You've used your verification budget for now. Try again in about ",
    countdownSuffix: ".",
    settledSubtitle: "You can try again now.",
    allowsImmediateRetry: true,
  },
  "chain-rate-limited": {
    // The on-chain reset cooldown is 7 days. We don't surface the exact
    // remaining time (would require reading IdentityState.last_reset_timestamp,
    // an extra RPC for a rare error path); the static copy makes the order of
    // magnitude clear without false precision.
    label: "COOLDOWN ACTIVE",
    title: "Reset cooldown active",
    countdownPrefix: "",
    countdownSuffix: "",
    settledSubtitle:
      "Anchor resets are limited to once per 7-day window on this network. Try again later.",
    allowsImmediateRetry: false,
  },
  "retry-now": {
    label: "TRY AGAIN",
    title: "Hit a snag",
    countdownPrefix: "",
    countdownSuffix: "",
    settledSubtitle: "The network or wallet didn't respond cleanly. Try again now.",
    allowsImmediateRetry: true,
  },
};

export default function VerifyFailure() {
  const router = useRouter();
  const { palette } = useTheme();
  const params = useLocalSearchParams<{
    bucket?: string;
    reason?: string;
    retryAfter?: string;
    message?: string;
  }>();
  const { setFlowIntent } = useAppState();

  // Re-enables the primary CTA from "OK" → "Try again" once the countdown
  // hits zero. Only meaningful for the retry branch; ignored elsewhere.
  const [retryReady, setRetryReady] = useState(false);

  const handleCopyDiagnostics = useCallback(async () => {
    const message = typeof params.message === "string" ? params.message : "";
    const text = `Entros mobile error\nbucket=${params.bucket}\ncode=${message}`;
    try {
      await Clipboard.setStringAsync(text);
    } catch {
      // Clipboard module may be unavailable on the host; the user has the
      // info on screen either way.
    }
  }, [params.bucket, params.message]);

  // Soft-reject branch — friendly hint + Try Again. Cyan tone, RefreshIcon.
  // Soft-rejects are NOT logged in verification history (matches the web
  // flow's soft_failed transition — they're transient retries, not failures).
  if (params.bucket === "soft") {
    const reason = typeof params.reason === "string" ? (params.reason as ValidateReason) : null;
    const hint = (reason && SOFT_HINT[reason]) || SOFT_HINT_FALLBACK;
    return (
      <Screen>
        <View style={styles.wrap}>
          <View style={styles.body}>
            <View
              style={[
                styles.bubble,
                { backgroundColor: `${palette.accent}1F`, borderColor: palette.accent },
              ]}
            >
              <RefreshIcon size={32} color={palette.accent} strokeWidth={2} />
            </View>
            <SectionLabel tone="muted">RETRY</SectionLabel>
            <Text variant="title" align="center">
              Let&apos;s try that again
            </Text>
            <Text variant="body" tone="muted" align="center">
              {hint}
            </Text>
          </View>
          <View style={styles.footer}>
            <Button label="Try again" onPress={() => router.replace("/verify/intro")} />
            <Button label="Cancel" variant="ghost" onPress={() => router.dismissAll()} />
          </View>
        </View>
      </Screen>
    );
  }

  // Retry branch — cyan tone, RefreshIcon, optional live countdown.
  // Covers HTTP rate-limit, on-chain cooldown, and transient retry-now
  // (stale blockhash, wallet timeout, network blip, clock drift).
  //
  // `params.bucket` is `string | undefined` — the URL layer can deliver any
  // string. Runtime-validate against the union before narrowing instead of
  // a naive cast: malformed deeplinks fall to "generic" instead of leaking
  // a bogus literal through to switch-case fallthrough.
  const bucketParam = params.bucket;
  const bucket: FailureBucket =
    typeof bucketParam === "string" && ALL_FAILURE_BUCKETS.has(bucketParam as FailureBucket)
      ? (bucketParam as FailureBucket)
      : "generic";
  if (RETRY_BUCKETS.has(bucket)) {
    const retryKey = bucket as RetryBucket;
    const config = retryBucketConfig[retryKey];
    const rawSec = Number(params.retryAfter ?? "0");
    const safeSec = Number.isFinite(rawSec) && rawSec > 0 ? Math.ceil(rawSec) : 0;
    const showCountdown = safeSec > 0 && !retryReady;
    // "Try again" only renders when (a) the bucket allows immediate retry
    // AND (b) the countdown isn't currently ticking. While the countdown
    // is live, only "OK" is offered to discourage premature retries.
    const showTryAgain = config.allowsImmediateRetry && !showCountdown;
    return (
      <Screen>
        <View style={styles.wrap}>
          <View style={styles.body}>
            <View
              style={[
                styles.bubble,
                { backgroundColor: `${palette.accent}1F`, borderColor: palette.accent },
              ]}
            >
              <RefreshIcon size={32} color={palette.accent} strokeWidth={2} />
            </View>
            <SectionLabel tone="muted">{config.label}</SectionLabel>
            <Text variant="title" align="center">
              {config.title}
            </Text>
            {showCountdown ? (
              <View style={styles.countdownRow}>
                <Text variant="body" tone="muted" align="center">
                  {config.countdownPrefix}
                </Text>
                <Countdown seconds={safeSec} onExpire={() => setRetryReady(true)} />
                {config.countdownSuffix ? (
                  <Text variant="body" tone="muted" align="center">
                    {config.countdownSuffix}
                  </Text>
                ) : null}
              </View>
            ) : (
              <Text variant="body" tone="muted" align="center">
                {config.settledSubtitle}
              </Text>
            )}
          </View>
          <View style={styles.footer}>
            {showTryAgain ? (
              <>
                <Button label="Try again" onPress={() => router.replace("/verify/intro")} />
                <Button label="Cancel" variant="ghost" onPress={() => router.dismissAll()} />
              </>
            ) : (
              <Button label="OK" onPress={() => router.dismissAll()} />
            )}
          </View>
        </View>
      </Screen>
    );
  }

  // Report-bug branch — danger tone, AlertIcon, "copy diagnostics" CTA.
  // Reserved for proof-rejected / commitment-binding / programming-error —
  // user-facing recovery is "send us this code". The clipboard write
  // is best-effort; on failure the user can still read the code on screen.
  if (bucket === "report-bug") {
    const codeFromMessage = typeof params.message === "string" ? params.message : "";
    return (
      <Screen>
        <View style={styles.wrap}>
          <View style={styles.body}>
            <View
              style={[
                styles.bubble,
                { backgroundColor: `${palette.danger}1F`, borderColor: palette.danger },
              ]}
            >
              <AlertIcon size={32} color={palette.danger} strokeWidth={2} />
            </View>
            <SectionLabel tone="muted">UNEXPECTED ERROR</SectionLabel>
            <Text variant="title" align="center">
              We hit a snag we didn&apos;t expect
            </Text>
            <Text variant="body" tone="muted" align="center">
              This is a bug on our end, not yours. Copy the code below and share it with the team.
            </Text>
            {codeFromMessage ? (
              <Text variant="body" align="center" tone="muted">
                {codeFromMessage}
              </Text>
            ) : null}
          </View>
          <View style={styles.footer}>
            <Button label="Copy diagnostics" onPress={handleCopyDiagnostics} />
            <Button
              label="Try again"
              variant="ghost"
              onPress={() => router.replace("/verify/intro")}
            />
          </View>
        </View>
      </Screen>
    );
  }

  // Hard failure branches — danger tone, AlertIcon.
  const hardKey = (bucket as HardBucket) in hardBucketCopy ? (bucket as HardBucket) : "generic";
  const copy = hardBucketCopy[hardKey];

  const handlePrimary = () => {
    if (hardKey === "baseline-missing") {
      // Set the verify-flow intent so /verify/processing routes the next
      // cycle through reset_identity_state instead of mint_anchor /
      // update_anchor. processing.tsx flips it back to "verify" on
      // successful reset. We do NOT call resetBaseline() here — Stage 5's
      // storeBaseline overwrites the local envelope during the reset
      // cycle's own IIFE, so pre-wiping would only race that write.
      setFlowIntent("reset");
      router.replace("/verify/intro");
      return;
    }
    router.replace("/verify/intro");
  };

  return (
    <Screen>
      <View style={styles.wrap}>
        <View style={styles.body}>
          <View
            style={[
              styles.bubble,
              { backgroundColor: `${palette.danger}1F`, borderColor: palette.danger },
            ]}
          >
            <AlertIcon size={32} color={palette.danger} strokeWidth={2} />
          </View>
          <SectionLabel tone="muted">FAILED</SectionLabel>
          <Text variant="title" align="center">
            {copy.title}
          </Text>
          <Text variant="body" tone="muted" align="center">
            {copy.subtitle}
          </Text>
        </View>
        <View style={styles.footer}>
          <Button
            label={copy.primary}
            variant={hardKey === "baseline-missing" ? "danger" : "primary"}
            onPress={handlePrimary}
          />
          {copy.secondary ? (
            <Button label={copy.secondary} variant="ghost" onPress={() => router.dismissAll()} />
          ) : null}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "space-between", paddingVertical: spacing.xl },
  body: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.xl },
  bubble: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    marginBottom: spacing.md,
  },
  countdownRow: {
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    flexWrap: "wrap",
  },
  footer: { gap: spacing.sm },
});
