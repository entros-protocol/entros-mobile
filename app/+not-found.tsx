import { Link, Stack } from "expo-router";
import { StyleSheet, View } from "react-native";

import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { spacing } from "@/theme/tokens";

export default function NotFound() {
  return (
    <>
      <Stack.Screen options={{ title: "Not found" }} />
      <Screen>
        <View style={styles.wrap}>
          <SectionLabel tone="muted">404</SectionLabel>
          <Text variant="title">This route does not exist.</Text>
          <Link href="/(app)">
            <Text variant="body" tone="accent">
              Return to dashboard
            </Text>
          </Link>
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
});
