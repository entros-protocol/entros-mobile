import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { OtherWalletLogo, PhantomLogo, SolflareLogo } from "@/components/icons/walletLogos";
import { Button } from "@/components/primitives/Button";
import { GlassCard } from "@/components/primitives/GlassCard";
import { GlowCard } from "@/components/primitives/GlowCard";
import { PrivacyPill } from "@/components/primitives/PrivacyPill";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { config } from "@/config";
import { useAppState } from "@/state/AppState";
import { WalletKind } from "@/state/types";
import { radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import {
  MWAAuthorizationFailedError,
  MWATimeoutError,
  MWAUnsupportedError,
  MWAUserRejectedError,
  MWAWalletNotInstalledError,
  openWalletPlayStore,
} from "@/wallet/mwa";

// `kind === null` means "let the OS chooser decide" — the MWA layer omits
// `walletPackage` from the transact config and falls through to App Links
// (the unpatched MWA path). Used for Seeker's preinstalled Seed Vault Wallet,
// which is auto-verified and doesn't need the Intent.setPackage workaround
// the patched module applies for Phantom/Solflare.
interface WalletEntry {
  kind: WalletKind | null;
  name: string;
  subtitle: string;
  Logo: React.FC<{ size?: number }>;
}

const wallets: WalletEntry[] = [
  { kind: "phantom", name: "Phantom", subtitle: "Mobile Wallet Adapter", Logo: PhantomLogo },
  { kind: "solflare", name: "Solflare", subtitle: "Mobile Wallet Adapter", Logo: SolflareLogo },
  {
    kind: null,
    name: "Other wallet",
    subtitle: "Seed Vault on Seeker, or any installed wallet",
    Logo: OtherWalletLogo,
  },
];

export default function Connect() {
  const router = useRouter();
  const { palette } = useTheme();
  const { connect } = useAppState();
  // `pending` keys by entry name (covers `kind: null` for the Seeker / OS-chooser
  // entry, where there is no WalletKind to key on).
  const [pending, setPending] = useState<string | null>(null);

  const offerInstall = (kind: WalletKind, name: string, title: string, body: string) => {
    Alert.alert(title, body, [
      { text: "Cancel", style: "cancel" },
      {
        text: `Install ${name}`,
        onPress: () => {
          void openWalletPlayStore(kind);
        },
      },
    ]);
  };

  const handleConnect = async (kind: WalletKind | null, name: string) => {
    if (pending) return;
    setPending(name);
    try {
      await connect(kind ?? undefined);
      router.replace("/(app)");
    } catch (err) {
      if (err instanceof MWAUserRejectedError) {
        // Silent — user explicitly cancelled.
      } else if (err instanceof MWAAuthorizationFailedError) {
        // Wallet auto-rejected pre-UI. Almost always a network/cluster mismatch.
        // Tell the user exactly which toggle to flip in the wallet.
        const cluster = config.cluster;
        Alert.alert(
          `${name} rejected the connection`,
          `${name} declined before showing approval. Most likely cause: the wallet's active network does not match this app's cluster (${cluster}).\n\n` +
            (kind === "phantom"
              ? 'In Phantom: Settings → Developer Settings → Testnet Mode → set network to "Solana Devnet" (not Solana Testnet), then try again.'
              : kind
                ? `In ${name}: switch the active network to ${cluster}, then try again.`
                : `Switch the wallet's active network to ${cluster}, then try again.`),
        );
      } else if (err instanceof MWAWalletNotInstalledError) {
        // Only fires for kind-specific connects (the SDK can't know which APK
        // to suggest installing on the OS-chooser path).
        if (kind) {
          offerInstall(
            kind,
            name,
            `${name} not installed`,
            `Install ${name} from the Play Store, set up a wallet, then come back.`,
          );
        } else {
          Alert.alert(
            "No compatible wallet found",
            "Install a Mobile Wallet Adapter wallet (Phantom, Solflare, or Seed Vault on Seeker), then try again.",
          );
        }
      } else if (err instanceof MWATimeoutError) {
        // Timeout = the wallet was reachable but its response stalled. This is
        // distinct from "not installed" (which is its own MWAWalletNotInstalledError
        // case above) — don't push the user to the Play Store on a timeout.
        Alert.alert(
          `${name} didn't respond in time`,
          `Make sure ${name} is open and a wallet is set up, then try again.`,
        );
      } else if (err instanceof MWAUnsupportedError) {
        Alert.alert(
          "Android only",
          "Mobile Wallet Adapter is supported on Android. Open this build on the AVD or a Solana Mobile device.",
        );
      } else {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (kind) {
          offerInstall(
            kind,
            name,
            `Could not connect to ${name}`,
            `${message}\n\nMake sure ${name} is installed and you have a wallet set up.`,
          );
        } else {
          Alert.alert(
            "Could not connect",
            `${message}\n\nMake sure a Mobile Wallet Adapter wallet is installed.`,
          );
        }
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <Screen scroll>
      <View style={styles.body}>
        <SectionLabel>CONNECT</SectionLabel>
        <Text variant="title">Connect a Solana wallet.</Text>

        <GlowCard glow style={styles.cluster}>
          <View>
            <Text variant="label" tone="muted">
              NETWORK
            </Text>
            <Text variant="bodyLarge" style={{ textTransform: "capitalize" }}>
              Solana {config.cluster}
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

        <SectionLabel>CHOOSE A WALLET</SectionLabel>
        <View style={styles.list}>
          {wallets.map(({ kind, name, subtitle, Logo }) => {
            const isPending = pending === name;
            const isDisabled = !!pending && !isPending;
            return (
              <GlassCard
                key={name}
                glow={isPending}
                padded={false}
                style={[styles.row, isDisabled && { opacity: 0.45 }]}
              >
                <View style={styles.rowLeft}>
                  <View style={[styles.logoWrap, { backgroundColor: palette.background }]}>
                    <Logo size={36} />
                  </View>
                  <View style={styles.rowText}>
                    <Text variant="heading">{name}</Text>
                    <Text variant="caption" tone="muted">
                      {subtitle}
                    </Text>
                  </View>
                </View>
                <Button
                  label={isPending ? "Opening…" : "Connect"}
                  size="sm"
                  loading={isPending}
                  disabled={isDisabled}
                  onPress={() => handleConnect(kind, name)}
                />
              </GlassCard>
            );
          })}
        </View>

        <PrivacyPill />

        <Text variant="caption" tone="subtle">
          To switch accounts, change the active account in your wallet first, then reconnect.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.xl, paddingBottom: spacing.hero },
  cluster: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tag: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  list: { gap: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    flex: 1,
  },
  logoWrap: {
    width: 56,
    height: 56,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 2 },
});
