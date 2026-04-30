import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";

import { CheckIcon, ExternalIcon, RefreshIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { GlowCard } from "@/components/primitives/GlowCard";
import { PrivacyPill } from "@/components/primitives/PrivacyPill";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { relative } from "@/lib/format";
import { useAppState } from "@/state/AppState";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { explorerTxUrl } from "@/wallet/explorer";

type Row =
  | { kind: "reverify"; ts: Date; index: number; txSignature: string | null }
  | { kind: "reset"; ts: Date }
  | { kind: "mint"; ts: Date; afterReset: boolean };

/** Composes the on-chain identity into a flat, chronologically-descending
 *  list of activity rows. Source of truth: `IdentityState.recentTimestamps`
 *  (last N re-verifications), `lastResetAt` (single optional reset event),
 *  and `createdAt` (the original mint). The chain doesn't store per-event
 *  trust deltas or transaction signatures, so neither is rendered. Local
 *  in-memory tx sigs from the current session are surfaced when present
 *  via `historyByTimestamp` (a Map keyed to the second). */
function composeRows(
  recentTimestamps: Date[],
  lastResetAt: Date | null,
  createdAt: Date | null,
  totalVerifications: number,
  historyByTimestamp: Map<number, string>,
): Row[] {
  const rows: Row[] = [];

  // Re-verifications — newest first. The "#N" index counts down from the
  // total verification count (so the most-recent entry is "Re-verification
  // #N", oldest in the buffer is "Re-verification #(N - buffer + 1)").
  for (let i = 0; i < recentTimestamps.length; i += 1) {
    const ts = recentTimestamps[i];
    if (!ts) continue;
    const indexFromTop = totalVerifications - i;
    if (indexFromTop < 1) continue;
    const sigKey = Math.floor(ts.getTime() / 1000);
    rows.push({
      kind: "reverify",
      ts,
      index: indexFromTop,
      txSignature: historyByTimestamp.get(sigKey) ?? null,
    });
  }

  if (lastResetAt) {
    rows.push({ kind: "reset", ts: lastResetAt });
  }

  if (createdAt) {
    rows.push({ kind: "mint", ts: createdAt, afterReset: lastResetAt != null });
  }

  // Single descending sort handles the interleaving of mint / reset /
  // re-verification rows (a reset can fall between two re-verifications
  // chronologically; the mint always sits at the bottom).
  rows.sort((a, b) => b.ts.getTime() - a.ts.getTime());
  return rows;
}

export default function Activity() {
  const router = useRouter();
  const { connection, identity, history, hydrateIdentity } = useAppState();

  // Pull fresh on-chain state on focus so the activity list reflects the
  // current `recent_timestamps` buffer + counts. hydrateIdentity is a
  // no-op while a dev preset is active.
  useFocusEffect(
    useCallback(() => {
      if (connection.connected) void hydrateIdentity();
    }, [connection.connected, hydrateIdentity]),
  );

  // The chain doesn't surface tx signatures for past verifications, but
  // verifications fired THIS session are stored locally with their real
  // sigs. We key the local map by floor(timestamp/1000) so an in-memory
  // event lines up with the chain's per-second rounded timestamp without
  // matching exact Date equality.
  const historyByTimestamp = useMemo(() => {
    const map = new Map<number, string>();
    for (const event of history) {
      if (event.outcome !== "verified" || !event.txSignature) continue;
      map.set(Math.floor(event.ts.getTime() / 1000), event.txSignature);
    }
    return map;
  }, [history]);

  // Defensive `?? []` / `?? null` defaults below. Production state always
  // has these fields populated (the reducer's `loadPreset` / `verify` /
  // `resetComplete` / `hydrateIdentity` cases all set them; cold/preset
  // initial values include them). The fallbacks exist purely for the dev
  // Fast-Refresh case where the in-memory identity object pre-dates the
  // `IdentityState` type extension and is missing the new fields — without
  // them the activity screen crashes on `undefined.length`.
  //
  // The defaults are wrapped in their own `useMemo` so a `??` fallback to a
  // fresh empty array doesn't change reference on every render and defeat
  // the rows memo below.
  const recentTimestamps = useMemo(
    () => identity.recentTimestamps ?? [],
    [identity.recentTimestamps],
  );
  const lastResetAt = identity.lastResetAt ?? null;

  const rows = useMemo(
    () =>
      composeRows(
        recentTimestamps,
        lastResetAt,
        identity.createdAt,
        identity.verifications,
        historyByTimestamp,
      ),
    [recentTimestamps, lastResetAt, identity.createdAt, identity.verifications, historyByTimestamp],
  );

  return (
    <Screen scroll>
      <View style={{ gap: spacing.xs, marginBottom: spacing.xl }}>
        <SectionLabel>ACTIVITY</SectionLabel>
        <Text variant="title">Verification history</Text>
      </View>

      {rows.length === 0 ? (
        <View style={styles.empty}>
          <View style={styles.emptyTextBlock}>
            <Text variant="heading" align="center">
              Your history starts here.
            </Text>
            <Text variant="body" tone="muted" align="center">
              Each verification you complete is recorded on-chain. Run your first one to begin.
            </Text>
          </View>
          <Button label="Begin first verification" onPress={() => router.push("/verify/intro")} />
          <View style={{ marginTop: spacing.md }}>
            <PrivacyPill />
          </View>
        </View>
      ) : (
        <View style={styles.list}>
          {rows.map((row) => (
            <ActivityRow key={`${row.kind}-${row.ts.getTime()}`} row={row} />
          ))}
        </View>
      )}
    </Screen>
  );
}

const ActivityRow = ({ row }: { row: Row }) => {
  const { palette } = useTheme();
  const sig = row.kind === "reverify" ? row.txSignature : null;

  const tone =
    row.kind === "reset"
      ? { fg: palette.danger, bg: `${palette.danger}22` }
      : { fg: palette.solanaGreen, bg: `${palette.solanaGreen}22` };

  const icon =
    row.kind === "reset" ? (
      <RefreshIcon color={palette.danger} size={18} />
    ) : (
      <CheckIcon color={palette.solanaGreen} size={18} />
    );

  const title =
    row.kind === "reverify"
      ? `Re-verification #${row.index}`
      : row.kind === "reset"
        ? "Baseline reset"
        : row.afterReset
          ? "Anchor minted"
          : "Initial verification";

  const sub =
    row.kind === "reverify"
      ? "Behavioural consistency confirmed"
      : row.kind === "reset"
        ? "Local fingerprint re-enrolled"
        : row.afterReset
          ? "Anchor PDA + Token-2022 mint created"
          : "Behavioural baseline established";

  const handlePressSig = () => {
    if (!sig) return;
    void Linking.openURL(explorerTxUrl(sig));
  };

  const Body = (
    <View style={{ flex: 1, gap: 2 }}>
      <Text variant="bodyLarge">{title}</Text>
      <Text variant="caption" tone="muted">
        {relative(row.ts)} · {sub}
      </Text>
    </View>
  );

  return (
    <GlowCard style={styles.row}>
      <View style={[styles.iconBubble, { backgroundColor: tone.bg, borderColor: tone.fg }]}>
        {icon}
      </View>
      {sig ? (
        <Pressable
          onPress={handlePressSig}
          style={({ pressed }) => [pressed && { opacity: 0.7 }, { flex: 1 }]}
        >
          {Body}
        </Pressable>
      ) : (
        Body
      )}
      {sig ? (
        <Pressable
          onPress={handlePressSig}
          accessibilityRole="link"
          accessibilityLabel="Open transaction in Solana Explorer"
          style={({ pressed }) => [styles.tx, pressed && { opacity: 0.7 }]}
        >
          <Text variant="monoSmall" tone="accent">
            {sig.slice(0, 6)}…{sig.slice(-4)}
          </Text>
          <ExternalIcon color={palette.accent} size={14} />
        </Pressable>
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
