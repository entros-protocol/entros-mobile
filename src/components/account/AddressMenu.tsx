import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Alert, BackHandler, Dimensions, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { ChevronRightIcon, ExternalIcon, WalletIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { Text } from "@/components/primitives/Text";
import { useAppState } from "@/state/AppState";
import { radii, spacing } from "@/theme/tokens";
import { truncate } from "@/lib/format";
import { useTheme } from "@/theme/ThemeProvider";
import { explorerUrlForAddress } from "@/wallet/explorer";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const ANIMATION_MS = 280;

// Full-screen overlay rendered at the root of the app tree. Replaces the
// native Modal path because RN's Modal+transparent+slide is unreliable on
// Android Bridgeless mode (RN 0.76 New Architecture). Rendered exactly once,
// driven by AppState.ui.walletMenuOpen.
export const AddressMenu = () => {
  const router = useRouter();
  const { palette } = useTheme();
  const {
    connection,
    ui: { walletMenuOpen },
    closeWalletMenu,
    disconnect,
  } = useAppState();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<null | "disconnect">(null);

  const translateY = useSharedValue(SCREEN_HEIGHT);
  const backdropOpacity = useSharedValue(0);

  useEffect(() => {
    if (walletMenuOpen) {
      translateY.set(
        withTiming(0, {
          duration: ANIMATION_MS,
          easing: Easing.out(Easing.cubic),
        }),
      );
      backdropOpacity.set(withTiming(1, { duration: ANIMATION_MS }));
    } else {
      translateY.set(
        withTiming(SCREEN_HEIGHT, {
          duration: ANIMATION_MS,
          easing: Easing.in(Easing.cubic),
        }),
      );
      backdropOpacity.set(withTiming(0, { duration: ANIMATION_MS }));
    }
  }, [walletMenuOpen, translateY, backdropOpacity]);

  // Hardware back button on Android — close the sheet instead of navigating.
  useEffect(() => {
    if (!walletMenuOpen) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeWalletMenu();
      return true;
    });
    return () => sub.remove();
  }, [walletMenuOpen, closeWalletMenu]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.get() }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.get(),
  }));

  const address = connection.address;

  const handleCopy = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const handleExplorer = async () => {
    if (!address) return;
    await WebBrowser.openBrowserAsync(explorerUrlForAddress(address));
  };

  // Disconnect: clean MWA deauthorize + clear secure store + send user back
  // to /connect so they pick a wallet to reconnect (or close the modal).
  // Same path as "switch wallet" — there's no in-place wallet switch since MWA
  // doesn't expose an account picker, so disconnect-and-reconnect is canonical.
  const handleDisconnect = async () => {
    if (busy) return;
    setBusy("disconnect");
    try {
      await disconnect();
      closeWalletMenu();
      router.replace("/connect");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      Alert.alert("Disconnect failed", message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={walletMenuOpen ? "box-none" : "none"}>
      <Animated.View style={[styles.backdrop, backdropStyle]} pointerEvents="auto">
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={closeWalletMenu}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        />
      </Animated.View>
      <Animated.View style={[styles.sheetWrap, sheetStyle]} pointerEvents="box-none">
        <SafeAreaView
          edges={["bottom"]}
          style={[
            styles.sheet,
            {
              backgroundColor: palette.background,
              borderColor: palette.border,
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: palette.textSubtle }]} />

          <View style={styles.row}>
            <View style={[styles.iconBubble, { backgroundColor: palette.accentMuted }]}>
              <WalletIcon color={palette.accent} size={18} />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="label" tone="muted">
                CONNECTED WALLET
              </Text>
              <Text variant="bodyLarge">{connection.label ?? "Solana wallet"}</Text>
            </View>
          </View>

          <Pressable
            onPress={handleCopy}
            style={({ pressed }) => [
              styles.addressBox,
              { backgroundColor: palette.surface, borderColor: palette.border },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text variant="mono" numberOfLines={1}>
              {address ? truncate(address, 8, 8) : "—"}
            </Text>
            <Text variant="caption" tone={copied ? "accent" : "muted"}>
              {copied ? "Copied" : "Tap to copy"}
            </Text>
          </Pressable>

          <View style={styles.actions}>
            <ActionRow
              icon={<ExternalIcon color={palette.text} size={18} />}
              label="View on Solana Explorer"
              onPress={handleExplorer}
            />
          </View>

          <Button
            label={busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            variant="danger"
            loading={busy === "disconnect"}
            onPress={handleDisconnect}
          />
        </SafeAreaView>
      </Animated.View>
    </View>
  );
};

const ActionRow = ({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) => {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.actionRow,
        { backgroundColor: palette.surface, borderColor: palette.border },
        disabled && { opacity: 0.5 },
        pressed && !disabled && { opacity: 0.85 },
      ]}
    >
      <View style={styles.actionLeft}>
        <View style={[styles.actionIcon, { backgroundColor: palette.background }]}>{icon}</View>
        <Text variant="bodyLarge">{label}</Text>
      </View>
      <ChevronRightIcon color={palette.textMuted} size={18} />
    </Pressable>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheetWrap: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },
  sheet: {
    borderTopLeftRadius: radii.xxl,
    borderTopRightRadius: radii.xxl,
    borderTopWidth: 1,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.lg,
  },
  handle: {
    alignSelf: "center",
    width: 44,
    height: 4,
    borderRadius: 2,
    opacity: 0.5,
    marginBottom: spacing.sm,
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  addressBox: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  actions: { gap: spacing.sm },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
  },
  actionLeft: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  actionIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
});
