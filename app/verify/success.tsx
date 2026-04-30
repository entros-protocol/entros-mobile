import { useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { CheckIcon, ExternalIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { GlowCard } from "@/components/primitives/GlowCard";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { truncate } from "@/lib/format";
import { useAppState } from "@/state/AppState";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

export default function VerifySuccess() {
  const router = useRouter();
  const { palette } = useTheme();
  const { identity, history, hydrateIdentity } = useAppState();
  const last = history[0];

  // The processing screen has already optimistically dispatched `verify` /
  // `resetComplete` so the trustDelta animation could land before the tx
  // confirmed. Reconcile against on-chain state here so the COMMITMENT
  // field reflects the freshly-rotated PDA value rather than whatever the
  // local mock had cached. Fire-and-forget — UI is happy with stale state
  // and updates whenever the RPC resolves.
  useEffect(() => {
    void hydrateIdentity();
  }, [hydrateIdentity]);
  return (
    <Screen>
      <View style={styles.wrap}>
        <View style={styles.body}>
          <View
            style={[
              styles.checkBubble,
              { backgroundColor: `${palette.solanaGreen}1F`, borderColor: palette.solanaGreen },
            ]}
          >
            <CheckIcon size={36} color={palette.solanaGreen} strokeWidth={2} />
          </View>
          <SectionLabel tone="muted">VERIFIED</SectionLabel>
          <Text variant="title" align="center">
            Your humanness is{"\n"}recorded on-chain.
          </Text>
          <View style={styles.fields}>
            <GlowCard style={styles.field}>
              <Text variant="label" tone="muted">
                COMMITMENT
              </Text>
              <Text variant="mono" numberOfLines={1}>
                {identity.commitment ? truncate(identity.commitment, 8, 6) : "—"}
              </Text>
            </GlowCard>
            {last?.txSignature ? (
              <GlowCard style={styles.field}>
                <Text variant="label" tone="muted">
                  TRANSACTION
                </Text>
                <View style={styles.row}>
                  <Text variant="mono" tone="accent" numberOfLines={1} ellipsizeMode="middle">
                    {last.txSignature}
                  </Text>
                  <ExternalIcon size={14} color={palette.accent} />
                </View>
              </GlowCard>
            ) : null}
          </View>
        </View>
        <View style={styles.footer}>
          <Button label="Done" onPress={() => router.dismissAll()} />
          <Button
            label="Verify again"
            variant="ghost"
            onPress={() => router.replace("/verify/intro")}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "space-between", paddingVertical: spacing.xl },
  body: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.xl },
  checkBubble: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    marginBottom: spacing.md,
  },
  fields: { width: "100%", gap: spacing.md, marginTop: spacing.md },
  field: { gap: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  footer: { gap: spacing.sm },
});
