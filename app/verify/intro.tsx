import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { MicIcon, MotionIcon, TouchIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { GlowCard } from "@/components/primitives/GlowCard";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { getConnection } from "@/config";
import { devWarn } from "@/lib/log";
import { fetchProtocolConfig, formatLamportsAsSol } from "@/protocol/protocolConfig";
import { audioPermissionGranted, requestAudioPermission } from "@/sensor/audio";
import { fetchChallenge } from "@/services/executor";
import { useAppState } from "@/state/AppState";
import { setChallenge } from "@/state/challengeBuffer";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

interface Step {
  Icon: React.FC<{ size?: number; color?: string }>;
  title: string;
  body: string;
}

const steps: Step[] = [
  { Icon: MicIcon, title: "Speak", body: "Read the phrase aloud, naturally." },
  { Icon: TouchIcon, title: "Trace", body: "Trace the on-screen curve at your own pace." },
  { Icon: MotionIcon, title: "Hold", body: "Hold the device steady through the count." },
];

// Default fallback when the on-chain ProtocolConfig read fails (RPC error,
// PDA uninitialized, env unset). Matches the protocol's devnet default of
// 5_000_000 lamports = 0.005 SOL so the user never sees "—".
const DEFAULT_FEE_LABEL = "≈ 0.005 SOL";

/** Subtle staggered pulse for the modality icons. Each step's icon breathes
 *  on a 2s cycle with a per-index delay so the three never sync into a
 *  distracting unison. Cancels on unmount. */
function usePulse(delayMs: number) {
  const value = useSharedValue(0);
  useEffect(() => {
    value.value = withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 1000, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 1000, easing: Easing.in(Easing.quad) }),
        ),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(value);
  }, [delayMs, value]);
  return useAnimatedStyle(() => ({
    opacity: 0.7 + value.value * 0.3,
    transform: [{ scale: 1 + value.value * 0.06 }],
  }));
}

const PulseIcon = ({
  Icon,
  color,
  delayMs,
}: {
  Icon: React.FC<{ size?: number; color?: string }>;
  color: string;
  delayMs: number;
}) => {
  const animStyle = usePulse(delayMs);
  return (
    <Animated.View style={animStyle}>
      <Icon size={20} color={color} />
    </Animated.View>
  );
};

export default function VerifyIntro() {
  const router = useRouter();
  const { palette } = useTheme();
  const { connection } = useAppState();
  const [pending, setPending] = useState(false);
  const [feeLabel, setFeeLabel] = useState<string>(DEFAULT_FEE_LABEL);

  // Fetch the live verification fee from ProtocolConfig once on mount. The
  // result is cosmetic — Begin still proceeds even if the read failed —
  // but a fresh read keeps the displayed estimate aligned with current
  // protocol parameters (admin can rotate the fee at any time).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await fetchProtocolConfig(getConnection());
      if (cancelled || !cfg) return;
      setFeeLabel(formatLamportsAsSol(cfg.verificationFeeLamports));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Gate the OS permission popup on the user's clear intent (Begin tap),
  // BEFORE the countdown. Android only requires RECORD_AUDIO at runtime;
  // accelerometer / gyroscope are unrestricted, and touch needs no
  // permission on either platform. After permission resolves, fetch the
  // server-issued challenge — the executor binds the nonce + phrase to
  // the wallet for a 60s TTL, so we want the nonce as fresh as possible
  // before capture starts.
  const handleBegin = async () => {
    if (pending) return;
    setPending(true);
    try {
      const wallet = connection.address;
      if (!wallet) {
        // Reachable if the dashboard let an unconnected user through. Send
        // them back to the connect picker rather than failing silently.
        router.replace("/connect");
        return;
      }

      const already = await audioPermissionGranted();
      if (!already) {
        const granted = await requestAudioPermission();
        if (!granted) {
          Alert.alert(
            "Microphone access required",
            "Entros needs the microphone to capture a 12-second voice sample. Grant access in System Settings → Apps → Entros → Permissions, then try again.",
          );
          return;
        }
      }

      try {
        const challenge = await fetchChallenge(wallet);
        setChallenge({ nonce: challenge.nonce, phrase: challenge.phrase });
        devWarn(`[Entros] /challenge ok ttl=${challenge.expiresIn}s`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not reach the executor.";
        Alert.alert("Couldn't fetch challenge", `${message}\n\nCheck your network and try again.`);
        return;
      }

      router.replace("/verify/capture");
    } finally {
      setPending(false);
    }
  };

  return (
    <Screen>
      <View style={styles.wrap}>
        <View style={styles.body}>
          <SectionLabel>VERIFICATION</SectionLabel>
          <Text variant="title">Three signals,{"\n"}twelve seconds.</Text>
          <Text variant="body" tone="muted">
            We capture how you speak, hold, and tap, then prove your humanness with a zero-knowledge
            proof. Raw signals stay on the device.
          </Text>
          <View style={styles.steps}>
            {steps.map((s, i) => (
              <GlowCard key={s.title} style={styles.step}>
                <View style={[styles.bubble, { backgroundColor: palette.accentMuted }]}>
                  <PulseIcon Icon={s.Icon} color={palette.accent} delayMs={i * 400} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="heading">{s.title}</Text>
                  <Text variant="body" tone="muted">
                    {s.body}
                  </Text>
                </View>
              </GlowCard>
            ))}
          </View>
        </View>
        <View style={styles.footer}>
          <View style={styles.feeRow}>
            <Text variant="caption" tone="muted">
              Network fee
            </Text>
            <Text variant="mono">{feeLabel}</Text>
          </View>
          <Button label="Begin" loading={pending} onPress={handleBegin} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Single column, top-aligned body, footer pinned to the bottom via flex:1
  // distribution. No `minHeight` (was forcing a phantom gap when content
  // was shorter than the screen) and no `scroll` Screen (intro fits on
  // every supported phone — scrolling would be a regression).
  wrap: { flex: 1, justifyContent: "space-between" },
  body: { gap: spacing.lg },
  steps: { gap: spacing.md },
  step: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  bubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: { gap: spacing.md, paddingBottom: spacing.lg },
  feeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
  },
});
