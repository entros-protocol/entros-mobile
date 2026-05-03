import { ActivityIndicator, Pressable, StyleSheet, View, ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import { fontFamily, fontSize, radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { Text } from "./Text";

// Lighten the cyan accent toward white for the gradient top stop. Keeping the
// shift small (≈10% toward white) so the button doesn't read as a different
// hue — just gains the catch-light a glossier surface would have.
const lighten = (hex: string, amount: number): string => {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m || !m[1]) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.min(255, Math.max(0, ((n >> 16) & 0xff) + Math.round(255 * amount)));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + Math.round(255 * amount)));
  const b = Math.min(255, Math.max(0, (n & 0xff) + Math.round(255 * amount)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
};
const darken = (hex: string, amount: number): string => lighten(hex, -amount);

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

  // Primary buttons get a vertical cyan gradient + outer cyan shadow. Other
  // variants stay flat — the gradient is reserved for the single primary CTA
  // per screen so it earns user attention rather than competing with itself.
  const isPrimary = variant === "primary";

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
          backgroundColor: isPrimary ? "transparent" : colors.bg,
          borderColor: colors.border,
        },
        isPrimary && {
          shadowColor: palette.glow,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 1,
          shadowRadius: 18,
          elevation: 8,
        },
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
    >
      {isPrimary ? (
        <LinearGradient
          pointerEvents="none"
          colors={[lighten(palette.accent, 0.1), palette.accent, darken(palette.accent, 0.08)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[StyleSheet.absoluteFillObject, { borderRadius: radii.lg }]}
        />
      ) : null}
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
    overflow: "hidden",
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
