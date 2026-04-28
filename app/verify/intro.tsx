import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { Button } from "@/components/primitives/Button";
import { GlowCard } from "@/components/primitives/GlowCard";
import { PrivacyPill } from "@/components/primitives/PrivacyPill";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { devWarn } from "@/lib/log";
import { audioPermissionGranted, requestAudioPermission } from "@/sensor/audio";
import { fetchChallenge } from "@/services/executor";
import { useAppState } from "@/state/AppState";
import { setChallenge } from "@/state/challengeBuffer";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

const steps = [
  { n: 1, title: "Speak", body: "Read the phrase aloud, naturally." },
  { n: 2, title: "Trace", body: "Trace the on-screen curve at your own pace." },
  { n: 3, title: "Hold", body: "Hold the device steady through the count." },
];

export default function VerifyIntro() {
  const router = useRouter();
  const { palette } = useTheme();
  const { connection } = useAppState();
  const [pending, setPending] = useState(false);

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
    <Screen scroll>
      <View style={styles.wrap}>
        <View style={styles.body}>
          <SectionLabel>VERIFICATION</SectionLabel>
          <Text variant="title">Three signals,{"\n"}twelve seconds.</Text>
          <Text variant="body" tone="muted">
            We capture how you speak, hold, and tap — then prove your humanness with a
            zero-knowledge proof. Raw signals stay on the device.
          </Text>
          <View style={styles.steps}>
            {steps.map((s) => (
              <GlowCard key={s.n} style={styles.step}>
                <View
                  style={[
                    styles.bubble,
                    { backgroundColor: palette.background, borderColor: palette.accent },
                  ]}
                >
                  <Text variant="mono" tone="accent">
                    {s.n}
                  </Text>
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
          <PrivacyPill />
        </View>
        <View style={styles.footer}>
          <View style={styles.feeRow}>
            <Text variant="caption" tone="muted">
              Network fee
            </Text>
            <Text variant="mono" tone="muted">
              ≈ 0.005 SOL
            </Text>
          </View>
          <Button label="Begin" loading={pending} onPress={handleBegin} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: "space-between",
    paddingVertical: spacing.lg,
    gap: spacing.xl,
    minHeight: 600,
  },
  body: { gap: spacing.xl },
  steps: { gap: spacing.md },
  step: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  bubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: { gap: spacing.md },
  feeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
  },
});
