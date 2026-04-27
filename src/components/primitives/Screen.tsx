import { ReactNode } from "react";
import { ScrollView, StatusBar, StyleSheet, View, ViewStyle } from "react-native";
import { Edge, SafeAreaView } from "react-native-safe-area-context";

import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  edges?: readonly Edge[];
  contentStyle?: ViewStyle;
  testID?: string;
}

export const Screen = ({
  children,
  scroll = false,
  padded = true,
  edges = ["top", "bottom"],
  contentStyle,
  testID,
}: ScreenProps) => {
  const { palette, mode } = useTheme();
  const padding = padded ? spacing.xxl : 0;

  const inner = (
    <View style={[{ flex: 1, paddingHorizontal: padding }, contentStyle]} testID={testID}>
      {children}
    </View>
  );

  return (
    <SafeAreaView edges={edges} style={[styles.safe, { backgroundColor: palette.background }]}>
      <StatusBar barStyle={mode === "dark" ? "light-content" : "dark-content"} />
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingVertical: spacing.xl, flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
        >
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
});
