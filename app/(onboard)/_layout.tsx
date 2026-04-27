import { Stack } from "expo-router";

import { useTheme } from "@/theme/ThemeProvider";

export default function OnboardLayout() {
  const { palette } = useTheme();
  return (
    <Stack
      screenOptions={{
        // Onboarding screens are full-bleed — no native header bar takes
        // vertical space at the top of the layout. Each screen renders its
        // own back affordance when needed.
        headerShown: false,
        contentStyle: { backgroundColor: palette.background },
        animation: "slide_from_right",
      }}
    />
  );
}
