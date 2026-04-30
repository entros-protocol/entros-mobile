import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { StyleSheet, View } from "react-native";

import { ChevronRightIcon, RefreshIcon } from "@/components/icons";
import { AddressBadge } from "@/components/primitives/AddressBadge";
import { Button } from "@/components/primitives/Button";
import { GlowCard } from "@/components/primitives/GlowCard";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { StatusPill } from "@/components/primitives/StatusPill";
import { Text } from "@/components/primitives/Text";
import { relative, truncate } from "@/lib/format";
import { useAppState } from "@/state/AppState";
import { fontFamily, radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

export default function Dashboard() {
  const router = useRouter();
  const { palette } = useTheme();
  const { connection, identity, openWalletMenu, hydrateIdentity } = useAppState();

  // Refresh from the on-chain IdentityState PDA whenever the dashboard tab
  // gains focus. Covers cold start, returning from /verify/success, and
  // tab switches. The reducer dispatches inside hydrateIdentity are no-ops
  // when nothing changed, so this stays quiet for repeated focuses.
  useFocusEffect(
    useCallback(() => {
      if (connection.connected) void hydrateIdentity();
    }, [connection.connected, hydrateIdentity]),
  );

  if (!connection.connected) {
    return (
      <Screen>
        <View style={styles.empty}>
          <SectionLabel>NOT CONNECTED</SectionLabel>
          <Text variant="title">Connect your wallet</Text>
          <Text variant="body" tone="muted">
            Connect a Solana wallet to mint your Entros Anchor and start building your Trust Score.
          </Text>
          <Button label="Connect wallet" onPress={() => router.push("/connect")} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View style={styles.header}>
        <View style={{ gap: spacing.xs }}>
          <SectionLabel>DASHBOARD</SectionLabel>
          <Text variant="title">Trust Score</Text>
        </View>
        <AddressBadge address={connection.address} onPress={openWalletMenu} />
      </View>

      <GlowCard glow style={styles.scoreCard}>
        <View style={styles.scoreTop}>
          <StatusPill status={identity.hasAnchor ? "verified" : "unverified"} />
          <Text variant="caption" tone="muted">
            {identity.hasAnchor ? "Anchor minted" : "No anchor yet"}
          </Text>
        </View>
        <Text style={[styles.scoreValue, { color: palette.text }]} numberOfLines={1}>
          {identity.hasAnchor ? identity.trustScore : "—"}
        </Text>
        <View style={[styles.progressTrack, { backgroundColor: palette.border }]}>
          <View
            style={[
              styles.progressFill,
              {
                backgroundColor: palette.accent,
                // Cap the visual fill at 100% even when the trust score
                // exceeds it (the on-chain formula adds an age bonus that
                // can take the raw score above 100). The number itself is
                // surfaced as-is above.
                width: `${identity.hasAnchor ? Math.min(identity.trustScore, 100) : 0}%`,
              },
            ]}
          />
        </View>
        <Text variant="body" tone="muted">
          {identity.hasAnchor
            ? identity.trustScore === 0
              ? "Baseline established. Re-verify to start building your score."
              : "Re-verify weekly to keep your score active."
            : "Mint your Entros Anchor with a single 12-second verification."}
        </Text>
        <Button
          label={identity.hasAnchor ? "Re-verify" : "Mint Entros Anchor"}
          onPress={() => router.push("/verify/intro")}
          iconLeft={
            identity.hasAnchor ? <RefreshIcon color={palette.background} size={16} /> : undefined
          }
        />
      </GlowCard>

      <View style={styles.statsGrid}>
        <Stat label="VERIFICATIONS" value={String(identity.verifications)} />
        <Stat label="LAST VERIFIED" value={relative(identity.lastVerifiedAt)} />
        <Stat
          label="ANCHOR CREATED"
          value={identity.createdAt ? identity.createdAt.toLocaleDateString() : "—"}
        />
        <Stat
          label="COMMITMENT"
          value={identity.commitment ? truncate(identity.commitment, 6, 4) : "—"}
          mono
        />
      </View>

      {identity.mint ? (
        <GlowCard padded={false} style={styles.metaCard}>
          <MetaRow label="Owner" value={truncate(connection.address ?? "", 6, 4)} />
          <View style={[styles.divider, { backgroundColor: palette.border }]} />
          <MetaRow
            label="Mint"
            value={truncate(identity.mint, 8, 6)}
            iconRight={<ChevronRightIcon color={palette.textMuted} size={16} />}
          />
        </GlowCard>
      ) : null}
    </Screen>
  );
}

const Stat = ({ label, value, mono }: { label: string; value: string; mono?: boolean }) => (
  <GlowCard style={styles.stat}>
    <Text variant="label" tone="muted">
      {label}
    </Text>
    <Text variant={mono ? "mono" : "heading"} numberOfLines={1}>
      {value}
    </Text>
  </GlowCard>
);

const MetaRow = ({
  label,
  value,
  iconRight,
}: {
  label: string;
  value: string;
  iconRight?: React.ReactNode;
}) => (
  <View style={styles.metaRow}>
    <Text variant="caption" tone="muted">
      {label}
    </Text>
    <View style={styles.metaRight}>
      <Text variant="mono">{value}</Text>
      {iconRight}
    </View>
  </View>
);

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.md,
    paddingBottom: spacing.hero,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xl,
  },
  scoreCard: {
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  scoreTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  scoreValue: {
    // Inter Bold at this size needs ~1.1× line height for full glyph
    // headroom (the prior 60px font / 62px lineHeight clipped digit caps
    // on Android). 56px is large enough to read as a hero number on a
    // dashboard tile without overwhelming the surrounding cards.
    fontFamily: fontFamily.bold,
    fontSize: 56,
    lineHeight: 62,
    letterSpacing: -1.5,
    includeFontPadding: false,
  },
  progressTrack: {
    height: 4,
    borderRadius: radii.pill,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: radii.pill,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  stat: {
    flexBasis: "47%",
    flexGrow: 1,
    gap: spacing.sm,
  },
  metaCard: {
    paddingVertical: spacing.md,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  metaRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  divider: { height: 1 },
});
