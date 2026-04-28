import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AlertIcon, RefreshIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
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

const bucketCopy: Record<
  FailureBucket,
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
  "rate-limited": {
    // Real entry exists in case the rate-limited route is reached without a
    // retryAfter param (defensive — the dedicated branch below handles the
    // common case with a derived countdown).
    title: "Too many attempts",
    subtitle: "You've used your verification budget for now. Try again in a moment.",
    primary: "OK",
  },
  generic: {
    title: "Verification failed",
    subtitle: "Something went wrong. Try again, or come back in a few minutes.",
    primary: "Try again",
    secondary: "Cancel",
  },
};

const formatRetryWindow = (retryAfterSec: number): string => {
  if (retryAfterSec >= 60) {
    const mins = Math.ceil(retryAfterSec / 60);
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  }
  return `${retryAfterSec} second${retryAfterSec === 1 ? "" : "s"}`;
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
  const { resetBaseline } = useAppState();

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

  // Rate-limited branch — cyan tone, RefreshIcon, derived countdown copy.
  // The static window is intentional; live-tick countdown is Stage 9 polish.
  if (params.bucket === "rate-limited") {
    const raw = Number(params.retryAfter ?? "60");
    const safeSec = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 60;
    const wait = formatRetryWindow(safeSec);
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
            <SectionLabel tone="muted">RATE LIMITED</SectionLabel>
            <Text variant="title" align="center">
              Too many attempts
            </Text>
            <Text variant="body" tone="muted" align="center">
              You&apos;ve used your verification budget for now. Try again in about {wait}.
            </Text>
          </View>
          <View style={styles.footer}>
            <Button label="OK" onPress={() => router.dismissAll()} />
          </View>
        </View>
      </Screen>
    );
  }

  // Hard failure branches — danger tone, AlertIcon.
  const bucket: FailureBucket = (params.bucket as FailureBucket) ?? "generic";
  const copy = bucketCopy[bucket] ?? bucketCopy.generic;

  const handlePrimary = () => {
    if (bucket === "baseline-missing") {
      resetBaseline();
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
            variant={bucket === "baseline-missing" ? "danger" : "primary"}
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
  footer: { gap: spacing.sm },
});
