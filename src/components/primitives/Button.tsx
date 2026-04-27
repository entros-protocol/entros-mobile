import { ActivityIndicator, Pressable, StyleSheet, View, ViewStyle } from "react-native";

import { fontFamily, fontSize, radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { Text } from "./Text";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
}

export const Button = ({
  label,
  onPress,
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  iconLeft,
  iconRight,
  style,
  testID,
}: ButtonProps) => {
  const { palette } = useTheme();
  const isDisabled = disabled || loading;

  const heightBySize: Record<Size, number> = { sm: 40, md: 52, lg: 60 };
  const fontSizeBySize: Record<Size, number> = {
    sm: fontSize.small,
    md: fontSize.body,
    lg: fontSize.bodyLarge,
  };

  const colors = ((): { bg: string; border: string; text: string; spinner: string } => {
    switch (variant) {
      case "primary":
        return {
          bg: palette.accent,
          border: palette.accent,
          text: palette.background,
          spinner: palette.background,
        };
      case "secondary":
        return {
          bg: "transparent",
          border: palette.border,
          text: palette.text,
          spinner: palette.text,
        };
      case "ghost":
        return {
          bg: "transparent",
          border: "transparent",
          text: palette.accent,
          spinner: palette.accent,
        };
      case "danger":
        return {
          bg: "transparent",
          border: palette.danger,
          text: palette.danger,
          spinner: palette.danger,
        };
    }
  })();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        {
          height: heightBySize[size],
          paddingHorizontal: size === "sm" ? spacing.lg : spacing.xxl,
          backgroundColor: colors.bg,
          borderColor: colors.border,
        },
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.spinner} />
      ) : (
        <View style={styles.content}>
          {iconLeft ? <View style={styles.iconLeft}>{iconLeft}</View> : null}
          <Text
            style={{
              color: colors.text,
              fontFamily: fontFamily.semiBold,
              fontSize: fontSizeBySize[size],
              letterSpacing: 0.2,
            }}
          >
            {label}
          </Text>
          {iconRight ? <View style={styles.iconRight}>{iconRight}</View> : null}
        </View>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.lg,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  iconLeft: { marginRight: spacing.sm },
  iconRight: { marginLeft: spacing.sm },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.78 },
});
