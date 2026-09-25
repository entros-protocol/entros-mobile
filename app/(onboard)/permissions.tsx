import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { MicIcon, MotionIcon, TouchIcon } from "@/components/icons";
import { BackButton } from "@/components/primitives/BackButton";
import { Button } from "@/components/primitives/Button";
import { ProgressDots } from "@/components/primitives/ProgressDots";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { isMotionAvailable } from "@/sensor/motion";
import { requestAudioPermission } from "@/sensor/audio";
import { useAppState } from "@/state/AppState";
import { fontFamily, radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

interface Row {
  Icon: React.FC<{ size?: number; color?: string }>;
  title: string;
  body: string;
}

const rows: Row[] = [
  {
    Icon: MicIcon,
    title: "Microphone",
    body: "Entros processes it on-device and sends it for phrase matching.",
  },
  {
    Icon: MotionIcon,
    title: "Motion sensors",
    body: "Accelerometer and gyroscope. Raw samples stay on the phone.",
  },
  {
    Icon: TouchIcon,
    title: "Touch trace",
    body: "How you tap and trace the canvas. Normalised on-device.",
  },
];

export default function Permissions() {
  const router = useRouter();
  const { palette } = useTheme();
  const { completeOnboarding } = useAppState();
  const [busy, setBusy] = useState(false);

  const handleContinue = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const audioOk = await requestAudioPermission();
      if (!audioOk) {
        Alert.alert(
          "Microphone access needed",
          "Entros can't run a verification without the microphone. You can grant access from Settings.",
        );
        return;
      }
      // expo-sensors does not require a runtime permission on Android for
      // accelerometer / gyroscope; on iOS the OS prompts on first use of
      // DeviceMotionEvent. We just check availability and surface gracefully
      // if unsupported.
      const motionOk = await isMotionAvailable();
      if (!motionOk) {
        Alert.alert(
          "Motion sensors unavailable",
          "This device does not expose accelerometer / gyroscope. You can still verify, but motion features will use touch as a proxy.",
        );
      }
      completeOnboarding();
      router.replace("/connect");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.wrap}>
        <View style={styles.topNav}>
          <BackButton />
        </View>

        <View style={styles.body}>
          <View style={styles.heading}>
            <SectionLabel>PERMISSIONS</SectionLabel>
            <Text variant="title">Three signals,{"\n"}twelve seconds.</Text>
            <Text variant="body" tone="muted">
              We capture how you speak, hold, and tap. Nothing leaves the phone in raw form.
            </Text>
          </View>

          <View style={styles.rows}>
            {rows.map(({ Icon, title, body }) => (
              <View
                key={title}
                style={[
                  styles.row,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <View style={[styles.iconWrap, { backgroundColor: palette.accentMuted }]}>
                  <Icon size={16} color={palette.accent} />
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: palette.text }]}>{title}</Text>
                  <Text variant="caption" tone="muted">
                    {body}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.footer}>
          <ProgressDots total={3} active={2} />
          <Button label="Allow and continue" loading={busy} onPress={handleContinue} />
          <Text variant="caption" tone="subtle" align="center">
            Revoke any of these later in System Settings.
          </Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  topNav: { height: 36, justifyContent: "center" },
  body: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.xl,
  },
  heading: { gap: spacing.sm },
  rows: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: {
    fontFamily: fontFamily.semiBold,
    fontSize: 16,
    letterSpacing: -0.1,
  },
  footer: { gap: spacing.md, alignItems: "stretch" },
});
