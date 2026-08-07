// Dev-only splash preview. Renders the same hero block + spinner that
// flashes in `app/index.tsx` during the cold-start ready/hydrate window,
// but holds indefinitely so the user can audit UI design issues without
// the route auto-redirecting at 600ms. A small "Done" link returns to
// Settings. Gated behind __DEV__ at the Settings entry point — this file
// is excluded from production builds via Metro's dead-code elimination on
// the empty linker import.

import { useRouter } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";

import { EntrosLogo } from "@/components/primitives/EntrosLogo";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Spinner } from "@/components/primitives/Spinner";
import { Text } from "@/components/primitives/Text";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

export default function SplashPreview() {
  const router = useRouter();
  const { palette } = useTheme();

  return (
    <Screen padded={false}>
      <View style={styles.wrap}>
        <View style={styles.hero}>
          <EntrosLogo size={64} />
          <View style={styles.titleBlock}>
            <SectionLabel>ENTROS PROTOCOL</SectionLabel>
            <Text variant="title" align="center">
              Proof of Personhood{"\n"}for Solana.
            </Text>
            <Text variant="body" tone="muted" align="center">
              Private behavioral continuity, computed on-device.
            </Text>
          </View>
        </View>
        <View style={styles.cta}>
          <View style={{ alignItems: "center", gap: spacing.lg }}>
            <Spinner size={24} />
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Close splash preview and return to Settings"
              style={({ pressed }) => [pressed && { opacity: 0.6 }]}
            >
              <Text variant="caption" style={{ color: palette.textMuted }}>
                Tap to exit preview
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.hero,
    justifyContent: "space-between",
  },
  hero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.hero,
  },
  titleBlock: {
    alignItems: "center",
    gap: spacing.md,
  },
  cta: { gap: spacing.md, minHeight: 120 },
});
