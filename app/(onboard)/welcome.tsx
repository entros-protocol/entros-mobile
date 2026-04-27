import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { MicIcon, MotionIcon, TouchIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { EntrosLogo } from "@/components/primitives/EntrosLogo";
import { ProgressDots } from "@/components/primitives/ProgressDots";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { useAppState } from "@/state/AppState";
import { fontFamily, radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

const modalities: {
  Icon: React.FC<{ size?: number; color?: string }>;
  title: string;
  body: string;
}[] = [
  { Icon: MicIcon, title: "Voice", body: "Pitch, cadence, breath." },
  { Icon: MotionIcon, title: "Motion", body: "How you hold the phone." },
  { Icon: TouchIcon, title: "Touch", body: "How you tap and trace." },
];

export default function Welcome() {
  const router = useRouter();
  const { palette } = useTheme();
  const { connection } = useAppState();
  const isRevisit = connection.connected;

  return (
    <Screen>
      <View style={styles.wrap}>
        {/* The body block flexes to fill all space between the (empty) top
            and the fixed footer, with its content vertically centered.
            Onboarding content is short enough that this looks like it
            "rises from the middle" instead of stacking from the top. */}
        <View style={styles.body}>
          <View style={styles.hero}>
            <EntrosLogo size={84} />
            <View style={styles.titleBlock}>
              <SectionLabel>WELCOME</SectionLabel>
              <Text variant="title" align="center">
                Proof of Personhood,{"\n"}built for Solana.
              </Text>
              <Text variant="body" tone="muted" align="center">
                Proves you're still you, every time.
              </Text>
            </View>
          </View>

          <View style={styles.rows}>
            {modalities.map(({ Icon, title, body }) => (
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
          {isRevisit ? null : <ProgressDots total={3} active={0} />}
          <Button label="Continue" onPress={() => router.push("/(onboard)/privacy")} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    paddingBottom: spacing.lg,
  },
  body: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.xxl,
  },
  hero: { alignItems: "center", gap: spacing.lg },
  titleBlock: { gap: spacing.sm, alignItems: "center" },
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
  footer: { gap: spacing.lg, alignItems: "stretch" },
});
