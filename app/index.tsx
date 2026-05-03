import { useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/primitives/Button";
import { EntrosLogo } from "@/components/primitives/EntrosLogo";
import { HeroGlow } from "@/components/primitives/HeroGlow";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Spinner } from "@/components/primitives/Spinner";
import { Text } from "@/components/primitives/Text";
import { useAppState } from "@/state/AppState";
import { spacing } from "@/theme/tokens";

export default function Splash() {
  const router = useRouter();
  const { ready, hydrating, firstLaunch, connection } = useAppState();

  useEffect(() => {
    if (!ready || hydrating) return;
    const timer = setTimeout(() => {
      if (firstLaunch && !connection.connected) {
        router.replace("/(onboard)/welcome");
      } else if (connection.connected) {
        router.replace("/(app)");
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [ready, hydrating, firstLaunch, connection.connected, router]);

  const showLanding = ready && !hydrating && !firstLaunch && !connection.connected;

  return (
    <Screen padded={false}>
      <View style={styles.wrap}>
        <View style={styles.hero}>
          <HeroGlow size={340} topOffset={-140} />
          <EntrosLogo size={64} />
          <View style={styles.titleBlock}>
            <SectionLabel>ENTROS PROTOCOL</SectionLabel>
            <Text variant="title" align="center">
              Proof of Personhood{"\n"}for Solana.
            </Text>
            <Text variant="body" tone="muted" align="center">
              Behavioural temporal consistency, proven on-device.
            </Text>
          </View>
        </View>
        {showLanding ? (
          <View style={styles.cta}>
            <Button label="Connect wallet" onPress={() => router.push("/connect")} />
            <Button
              label="How it works"
              variant="ghost"
              onPress={() => router.push("/(onboard)/welcome")}
            />
          </View>
        ) : hydrating ? (
          <View style={styles.cta}>
            <View style={{ alignItems: "center" }}>
              <Spinner size={24} />
            </View>
          </View>
        ) : null}
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
