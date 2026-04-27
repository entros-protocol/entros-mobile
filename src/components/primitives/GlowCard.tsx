import { ReactNode } from "react";
import { StyleSheet, View, ViewStyle } from "react-native";

import { radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

interface GlowCardProps {
  children: ReactNode;
  glow?: boolean;
  padded?: boolean;
  style?: ViewStyle;
  testID?: string;
}

export const GlowCard = ({
  children,
  glow = false,
  padded = true,
  style,
  testID,
}: GlowCardProps) => {
  const { palette } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        {
          backgroundColor: palette.surface,
          borderColor: glow ? palette.borderFocus : palette.border,
          padding: padded ? spacing.xl : 0,
          shadowColor: glow ? palette.glow : "transparent",
        },
        glow && styles.cardGlow,
        style,
      ]}
    >
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.xl,
    borderWidth: 1,
  },
  cardGlow: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 24,
    elevation: 6,
  },
});
