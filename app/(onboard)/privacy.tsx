import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { LockIcon } from "@/components/icons";
import { BackButton } from "@/components/primitives/BackButton";
import { Button } from "@/components/primitives/Button";
import { ProgressDots } from "@/components/primitives/ProgressDots";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { useAppState } from "@/state/AppState";
import { fontFamily, radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

export default function Privacy() {
  const router = useRouter();
  const { palette } = useTheme();
  const { completeOnboarding, connection } = useAppState();

  // First-launch path: continue → mark onboarding done → connect wallet.
  // Revisit path (already connected): continue → return to the app.
  const isRevisit = connection.connected;

  const handleContinue = () => {
    if (isRevisit) {
      completeOnboarding();
      router.replace("/(app)");
    } else {
      router.push("/(onboard)/permissions");
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
            <SectionLabel>PRIVACY</SectionLabel>
            <Text variant="title">Raw motion and touch{"\n"}stay on your phone.</Text>
            <Text variant="body" tone="muted">
              The client sends phrase audio for transient validation and a derived feature summary
              for private checks. Protocol transactions contain commitments and account state.
            </Text>
          </View>

          <View
            style={[
              styles.card,
              { backgroundColor: palette.surface, borderColor: palette.borderFocus },
            ]}
          >
            <View style={[styles.iconWrap, { backgroundColor: palette.accentMuted }]}>
              <LockIcon size={18} color={palette.accent} />
            </View>
            <View style={styles.cardText}>
              <Text style={[styles.cardTitle, { color: palette.text }]}>
                No biometrics. No images.
              </Text>
              <Text variant="body" tone="muted">
                No faces, irises, or anatomical fingerprints. The client stores an encrypted
                behavioral baseline for re-verification.
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.footer}>
          {isRevisit ? null : <ProgressDots total={3} active={1} />}
          <Button label={isRevisit ? "Done" : "Continue"} onPress={handleContinue} />
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
  card: {
    borderRadius: radii.xl,
    borderWidth: 1,
    padding: spacing.lg,
    gap: spacing.md,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  cardText: { gap: spacing.xs },
  cardTitle: {
    fontFamily: fontFamily.semiBold,
    fontSize: 18,
    letterSpacing: -0.2,
  },
  footer: { gap: spacing.lg, alignItems: "stretch" },
});
