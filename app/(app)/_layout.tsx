import { Tabs } from "expo-router";

import { ActivityIcon, HomeIcon, SettingsIcon } from "@/components/icons";
import { useTheme } from "@/theme/ThemeProvider";

export default function AppLayout() {
  const { palette } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Icon-only nav. Removing labels keeps the chrome quiet and the
        // bottom band pure-black; the active-tint cyan glyph is the only
        // chrome element visible at a glance, which matches entros.io's
        // discipline of cyan as punctuation.
        tabBarShowLabel: false,
        tabBarStyle: {
          backgroundColor: palette.background,
          borderTopColor: palette.border,
          borderTopWidth: 1,
          height: 60,
          paddingTop: 8,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textMuted,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, focused }) => (
            <HomeIcon color={color} size={26} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarIcon: ({ color, focused }) => (
            <ActivityIcon color={color} size={26} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, focused }) => (
            <SettingsIcon color={color} size={26} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
    </Tabs>
  );
}
