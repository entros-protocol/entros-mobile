import { Stack } from "expo-router";

import { useTheme } from "@/theme/ThemeProvider";

export default function VerifyLayout() {
  const { palette } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: palette.background },
        headerTintColor: palette.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: palette.background },
        animation: "fade",
      }}
    >
      <Stack.Screen name="intro" options={{ title: "Verify", headerBackTitle: "Cancel" }} />
      <Stack.Screen name="capture" options={{ headerShown: false }} />
      <Stack.Screen name="processing" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="success" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="failure" options={{ headerShown: false, gestureEnabled: false }} />
    </Stack>
  );
}
