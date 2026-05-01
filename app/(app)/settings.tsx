import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Modal, Pressable, StyleSheet, TextInput, View } from "react-native";

import { LogoutIcon, WalletIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { GlowCard } from "@/components/primitives/GlowCard";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { ThemeToggle } from "@/components/primitives/ThemeToggle";
import { useAppState } from "@/state/AppState";
import { FailureBucket, MockPreset } from "@/state/types";
import { fontFamily, fontSize, radii, spacing } from "@/theme/tokens";
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

/** Phrase the user must type verbatim to confirm the destructive reset. */
const RESET_CONFIRM_PHRASE = "reset baseline";

export default function Settings() {
  const router = useRouter();
  const { palette } = useTheme();
  const {
    connection,
    disconnect,
    resetBaseline,
    loadPreset,
    clearPreset,
    setForceOutcome,
    openWalletMenu,
    hydrateIdentity,
    dev,
  } = useAppState();
  const [busy, setBusy] = useState<"disconnect" | "reset" | null>(null);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetPhrase, setResetPhrase] = useState("");

  // Dev preset taps are pure demo toggles now: tap an inactive preset to
  // override the dashboard with that mock state; tap the active preset
  // again to clear and restore the real on-chain state. The original
  // destructive "Cold start" behaviour (disconnect wallet + wipe baseline)
  // moved into the proper Disconnect / Reset baseline flows in WALLET +
  // DANGER sections — presets here are non-destructive previews only.
  const handlePresetTap = (key: MockPreset) => {
    if (busy) return;
    if (dev.activePreset === key) {
      // Toggle off: restore snapshot, then refresh identity from chain so
      // the dashboard reflects current on-chain truth instead of the
      // potentially-stale snapshot data. `force: true` bypasses the
      // demo-mode gate inside hydrateIdentity — the `clearPreset`
      // dispatch above is queued but `stateRef.current.dev.activePreset`
      // still points at the OLD value (React hasn't re-rendered between
      // the sync dispatch and our hydrate call), so without force the
      // gate would block the refresh and the user would see stale state
      // until the next focus event triggered a re-fetch.
      clearPreset();
      void hydrateIdentity({ force: true });
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

  const openResetModal = () => {
    setResetPhrase("");
    setResetModalOpen(true);
  };
  const closeResetModal = () => {
    setResetModalOpen(false);
    setResetPhrase("");
  };
  const confirmReset = () => {
    if (resetPhrase.trim().toLowerCase() !== RESET_CONFIRM_PHRASE) return;
    closeResetModal();
    resetBaseline();
  };
  const phraseMatches = resetPhrase.trim().toLowerCase() === RESET_CONFIRM_PHRASE;

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

      {__DEV__ ? (
        <Section title="DEV PANEL">
          <Text variant="caption" tone="muted">
            Tap a preset to preview that screen state. Tap again to disable and return to the live
            on-chain view.
          </Text>
          <View style={styles.choiceGrid}>
            {presets.map((p) => {
              const active = dev.activePreset === p.key;
              return (
                <Pressable
                  key={p.key}
                  onPress={() => handlePresetTap(p.key)}
                  disabled={busy !== null}
                  style={({ pressed }) => [
                    styles.choice,
                    {
                      backgroundColor: active ? palette.accentMuted : palette.surface,
                      borderColor: active ? palette.accent : palette.border,
                    },
                    pressed && { opacity: 0.7 },
                    busy !== null && { opacity: 0.5 },
                  ]}
                >
                  {/* Active state is signalled by the cyan border + cyan
                      title color alone — an explicit "ACTIVE" badge was
                      redundant and clipped against the card's right edge
                      on narrow phones. */}
                  <Text variant="bodyLarge" tone={active ? "accent" : "default"}>
                    {p.label}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {p.sub}
                  </Text>
                </Pressable>
              );
            })}
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
          <Text variant="caption" tone="muted">
            Inspect transient screens that auto-redirect:
          </Text>
          <Pressable
            onPress={() => router.push("/dev/splash-preview")}
            style={({ pressed }) => [pressed && { opacity: 0.85 }]}
          >
            <GlowCard style={styles.aboutRow}>
              <Text variant="bodyLarge">Preview splash</Text>
              <Text variant="caption" tone="muted">
                Hold the cold-start hero open for design review
              </Text>
            </GlowCard>
          </Pressable>
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

      {/* Danger zone — sits at the bottom of settings deliberately. Reset
          baseline is a destructive, slow-recovery action (the next verify
          mints a fresh anchor as if first-time); requiring the user to type
          the phrase verbatim prevents accidental taps. */}
      <Section title="DANGER">
        <Text variant="caption" tone="muted">
          Erases your on-device baseline. The next verification re-enrolls you from scratch. Your
          on-chain Anchor stays — only the local fingerprint envelope is wiped.
        </Text>
        <Button label="Reset baseline" variant="danger" onPress={openResetModal} />
      </Section>

      <Modal
        visible={resetModalOpen}
        animationType="fade"
        transparent
        onRequestClose={closeResetModal}
      >
        <Pressable
          style={[styles.modalBackdrop, { backgroundColor: "rgba(0,0,0,0.7)" }]}
          onPress={closeResetModal}
        >
          {/* Inner Pressable swallows backdrop taps so tapping the dialog body
              doesn't dismiss it. */}
          <Pressable
            style={[
              styles.modalCard,
              { backgroundColor: palette.surface, borderColor: palette.border },
            ]}
            onPress={() => {}}
          >
            <SectionLabel tone="muted">CONFIRM RESET</SectionLabel>
            <Text variant="title">Are you sure?</Text>
            <Text variant="body" tone="muted">
              This wipes your local biometric baseline. The next verification will mint a fresh
              first-time anchor. Type{" "}
              <Text variant="body" style={{ fontFamily: fontFamily.medium }}>
                reset baseline
              </Text>{" "}
              below to proceed.
            </Text>
            <TextInput
              value={resetPhrase}
              onChangeText={setResetPhrase}
              placeholder={RESET_CONFIRM_PHRASE}
              placeholderTextColor={palette.textSubtle}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={[
                styles.modalInput,
                {
                  backgroundColor: palette.background,
                  borderColor: phraseMatches ? palette.danger : palette.border,
                  color: palette.text,
                },
              ]}
            />
            <View style={styles.modalButtons}>
              <Button label="Cancel" variant="ghost" onPress={closeResetModal} />
              <Button
                label="Reset baseline"
                variant="danger"
                onPress={confirmReset}
                disabled={!phraseMatches}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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
  modalBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxl,
  },
  modalCard: {
    width: "100%",
    borderRadius: radii.xl,
    borderWidth: 1,
    padding: spacing.xxl,
    gap: spacing.md,
  },
  modalInput: {
    height: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    fontFamily: fontFamily.regular,
    fontSize: fontSize.body,
  },
  modalButtons: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
});
