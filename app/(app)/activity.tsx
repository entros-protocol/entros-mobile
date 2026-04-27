import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AlertIcon, CheckIcon, ExternalIcon, SparkleIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { GlowCard } from "@/components/primitives/GlowCard";
import { PrivacyPill } from "@/components/primitives/PrivacyPill";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { VerificationOrb } from "@/components/pulse/VerificationOrb";
import { relative } from "@/lib/format";
import { useAppState } from "@/state/AppState";
import { VerificationEvent } from "@/state/types";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

export default function Activity() {
  const router = useRouter();
  const { palette } = useTheme();
  const { history } = useAppState();

  return (
    <Screen scroll>
      <View style={{ gap: spacing.xs, marginBottom: spacing.xl }}>
        <SectionLabel>ACTIVITY</SectionLabel>
        <Text variant="title">Verification history</Text>
      </View>

      {history.length === 0 ? (
        <View style={styles.empty}>
          <VerificationOrb size={120} />
          <View style={styles.emptyTextBlock}>
            <Text variant="heading" align="center">
              Your history starts here.
            </Text>
            <Text variant="body" tone="muted" align="center">
              Each verification leaves a mark — a trust delta, a transaction signature, an anchor
              update. Run your first one to begin.
            </Text>
          </View>
          <Button
            label="Begin first verification"
            onPress={() => router.push("/verify/intro")}
            iconLeft={<SparkleIcon color={palette.background} size={16} />}
          />
          <View style={{ marginTop: spacing.md }}>
            <PrivacyPill />
          </View>
        </View>
      ) : (
        <View style={styles.list}>
          {history.map((event) => (
            <Row key={event.id} event={event} />
          ))}
        </View>
      )}
    </Screen>
  );
}

const Row = ({ event }: { event: VerificationEvent }) => {
  const { palette } = useTheme();
  const ok = event.outcome === "verified";
  return (
    <GlowCard style={styles.row}>
      <View
        style={[
          styles.iconBubble,
          {
            backgroundColor: ok ? `${palette.solanaGreen}22` : `${palette.danger}22`,
            borderColor: ok ? palette.solanaGreen : palette.danger,
          },
        ]}
      >
        {ok ? (
          <CheckIcon color={palette.solanaGreen} size={18} />
        ) : (
          <AlertIcon color={palette.danger} size={18} />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="bodyLarge">{ok ? "Verified" : "Failed"}</Text>
        <Text variant="caption" tone="muted">
          {relative(event.ts)} ·{" "}
          {ok ? `+${event.trustDelta} trust` : (event.failureBucket ?? "error")}
        </Text>
      </View>
      {event.txSignature ? (
        <View style={styles.tx}>
          <Text variant="monoSmall" tone="accent">
            {event.txSignature}
          </Text>
          <ExternalIcon color={palette.accent} size={14} />
        </View>
      ) : null}
    </GlowCard>
  );
};

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    paddingVertical: spacing.hero,
  },
  emptyTextBlock: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  list: { gap: spacing.md },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  iconBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  tx: { flexDirection: "row", alignItems: "center", gap: 4 },
});
