import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";

import { LogoutIcon, WalletIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { GlowCard } from "@/components/primitives/GlowCard";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { ThemeToggle } from "@/components/primitives/ThemeToggle";
import { useAppState } from "@/state/AppState";
import { FailureBucket, MockPreset } from "@/state/types";
import { radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

const presets: { key: MockPreset; label: string; sub: string }[] = [
  { key: "cold", label: "Cold start", sub: "First launch, nothing connected" },
  {
    key: "connected-no-anchor",
    label: "Connected, no anchor",
    sub: "Wallet linked, never verified",
  },
  { key: "connected-with-anchor", label: "Connected + anchor", sub: "Score 18, 4 events" },
  { key: "high-score", label: "High score", sub: "Score 87, 22 events" },
];

const outcomes: { key: "success" | FailureBucket | null; label: string }[] = [
  { key: null, label: "Random" },
  { key: "success", label: "Force success" },
  { key: "relayer-down", label: "Force relayer-down" },
  { key: "baseline-missing", label: "Force baseline-missing" },
  { key: "generic", label: "Force generic error" },
];

export default function Settings() {
  const router = useRouter();
  const { palette } = useTheme();
  const {
    connection,
    disconnect,
    resetBaseline,
    loadPreset,
    setForceOutcome,
    openWalletMenu,
    dev,
  } = useAppState();
  const [busy, setBusy] = useState<"disconnect" | "reset" | null>(null);

  // Dev preset taps. "cold" performs a true reset (disconnects wallet, wipes
  // baseline, navigates to onboarding) so it actually resembles a fresh launch
  // — the bare reducer-only `loadPreset("cold")` keeps the wallet auth token
  // around and leaves the user stranded on the settings tab. The other presets
  // are mock-state demos that should land the user on the dashboard so they
  // can see the refreshed state.
  const handlePresetTap = async (key: MockPreset) => {
    if (busy) return;
    if (key === "cold") {
      setBusy("reset");
      try {
        if (connection.connected) {
          try {
            await disconnect();
          } catch {
            // Token may already be invalid; proceed regardless.
          }
        }
        loadPreset("cold");
        resetBaseline();
        router.replace("/");
      } finally {
        setBusy(null);
      }
      return;
    }
    loadPreset(key);
    router.replace("/(app)");
  };

  const handleDisconnect = async () => {
    if (busy) return;
    setBusy("disconnect");
    try {
      await disconnect();
      router.replace("/connect");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      Alert.alert("Disconnect failed", message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen scroll>
      <View style={{ gap: spacing.xs, marginBottom: spacing.xl }}>
        <SectionLabel>SETTINGS</SectionLabel>
        <Text variant="title">Preferences</Text>
      </View>

      <Section title="APPEARANCE">
        <ThemeToggle />
      </Section>

      <Section title="NETWORK">
        <GlowCard style={styles.networkCard}>
          <View style={{ flex: 1 }}>
            <Text variant="bodyLarge">Solana Devnet</Text>
            <Text variant="caption" tone="muted">
              api.devnet.solana.com
            </Text>
          </View>
          <View
            style={[
              styles.tag,
              { borderColor: palette.solanaGreen, backgroundColor: `${palette.solanaGreen}18` },
            ]}
          >
            <Text variant="label" style={{ color: palette.solanaGreen }}>
              ACTIVE
            </Text>
          </View>
        </GlowCard>
        <Text variant="caption" tone="subtle">
          Mainnet ships with Entros v1.0.
        </Text>
      </Section>

      <Section title="WALLET">
        {connection.connected ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open wallet menu"
              onPress={openWalletMenu}
              style={({ pressed }) => [pressed && { opacity: 0.85 }]}
            >
              <GlowCard style={styles.walletCard}>
                <View style={styles.walletRow}>
                  <View style={[styles.walletIcon, { backgroundColor: palette.accentMuted }]}>
                    <WalletIcon color={palette.accent} size={18} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyLarge">{connection.label ?? "Solana wallet"}</Text>
                    <Text variant="monoSmall" tone="muted" numberOfLines={1}>
                      {connection.address}
                    </Text>
                  </View>
                </View>
              </GlowCard>
            </Pressable>
            <Button
              label={busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              variant="danger"
              loading={busy === "disconnect"}
              onPress={handleDisconnect}
              iconLeft={<LogoutIcon color={palette.danger} size={14} />}
            />
          </>
        ) : (
          <GlowCard style={styles.walletCard}>
            <Text variant="bodyLarge" tone="muted">
              Not connected
            </Text>
            <Button
              label="Connect wallet"
              size="sm"
              onPress={() => router.push("/connect")}
              style={{ marginTop: spacing.sm }}
            />
          </GlowCard>
        )}
      </Section>

      <Section title="IDENTITY">
        <Button
          label="Reset baseline"
          variant="danger"
          onPress={() => {
            resetBaseline();
          }}
        />
        <Text variant="caption" tone="subtle">
          Erases your on-device baseline. The next verification re-enrolls you.
        </Text>
      </Section>

      {__DEV__ ? (
        <Section title="DEV PANEL">
          <Text variant="caption" tone="muted">
            Mock-state presets — switch to demo every screen state.
          </Text>
          <View style={styles.choiceGrid}>
            {presets.map((p) => (
              <Pressable
                key={p.key}
                onPress={() => handlePresetTap(p.key)}
                disabled={busy !== null}
                style={({ pressed }) => [
                  styles.choice,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                  pressed && { opacity: 0.7 },
                  busy !== null && { opacity: 0.5 },
                ]}
              >
                <Text variant="bodyLarge">
                  {p.key === "cold" && busy === "reset" ? "Resetting…" : p.label}
                </Text>
                <Text variant="caption" tone="muted">
                  {p.sub}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text variant="caption" tone="muted">
            Force the next verification outcome:
          </Text>
          <View style={styles.choiceRow}>
            {outcomes.map((o) => {
              const active = dev.forceOutcome === o.key;
              return (
                <Pressable
                  key={String(o.key)}
                  onPress={() => setForceOutcome(o.key)}
                  style={({ pressed }) => [
                    styles.tagChoice,
                    {
                      borderColor: active ? palette.accent : palette.border,
                      backgroundColor: active ? palette.accentMuted : palette.surface,
                    },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text variant="caption" tone={active ? "accent" : "default"}>
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Section>
      ) : null}

      <Section title="ABOUT">
        <Pressable
          onPress={() => router.push("/(onboard)/welcome")}
          style={({ pressed }) => [pressed && { opacity: 0.85 }]}
        >
          <GlowCard style={styles.aboutRow}>
            <Text variant="bodyLarge">How Entros works</Text>
            <Text variant="caption" tone="muted">
              Replay the onboarding intro
            </Text>
          </GlowCard>
        </Pressable>
        <Text variant="caption" tone="muted">
          Entros mobile · scaffold v0.1
        </Text>
        <Text variant="caption" tone="subtle">
          Report a vulnerability: security@entros.io
        </Text>
      </Section>
    </Screen>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <View style={styles.section}>
    <SectionLabel tone="muted">{title}</SectionLabel>
    {children}
  </View>
);

const styles = StyleSheet.create({
  section: { gap: spacing.md, marginBottom: spacing.xl },
  networkCard: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  walletCard: { gap: spacing.sm },
  walletRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  walletIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  aboutRow: { gap: spacing.xs },
  tag: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  choiceGrid: { gap: spacing.sm },
  choice: {
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 4,
  },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  tagChoice: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
});
