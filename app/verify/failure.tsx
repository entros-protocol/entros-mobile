import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AlertIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { useAppState } from "@/state/AppState";
import { FailureBucket } from "@/state/types";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

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
  generic: {
    title: "Verification failed",
    subtitle: "Something went wrong. Try again, or come back in a few minutes.",
    primary: "Try again",
    secondary: "Cancel",
  },
};

export default function VerifyFailure() {
  const router = useRouter();
  const { palette } = useTheme();
  const params = useLocalSearchParams<{ bucket?: string }>();
  const bucket: FailureBucket = (params.bucket as FailureBucket) ?? "generic";
  const copy = bucketCopy[bucket];
  const { resetBaseline } = useAppState();

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
