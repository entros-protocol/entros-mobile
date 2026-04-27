import { Text as RNText, StyleSheet, TextProps as RNTextProps, TextStyle } from "react-native";

import { fontFamily, fontSize, lineHeight } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

type Variant =
  | "display"
  | "title"
  | "heading"
  | "body"
  | "bodyLarge"
  | "caption"
  | "mono"
  | "monoSmall"
  | "label";
type Tone = "default" | "muted" | "subtle" | "accent" | "danger" | "warning";

export interface TextProps extends RNTextProps {
  variant?: Variant;
  tone?: Tone;
  align?: TextStyle["textAlign"];
}

export const Text = ({
  variant = "body",
  tone = "default",
  align,
  style,
  children,
  ...rest
}: TextProps) => {
  const { palette } = useTheme();
  const colorByTone: Record<Tone, string> = {
    default: palette.text,
    muted: palette.textMuted,
    subtle: palette.textSubtle,
    accent: palette.accent,
    danger: palette.danger,
    warning: palette.warning,
  };

  return (
    <RNText
      {...rest}
      style={[styles[variant], { color: colorByTone[tone], textAlign: align }, style]}
    >
      {children}
    </RNText>
  );
};

const styles = StyleSheet.create({
  display: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.display,
    lineHeight: fontSize.display * lineHeight.tight,
    letterSpacing: 0.2,
  },
  title: {
    fontFamily: fontFamily.semiBold,
    fontSize: fontSize.title,
    lineHeight: fontSize.title * lineHeight.tight,
    letterSpacing: -0.2,
  },
  heading: {
    fontFamily: fontFamily.semiBold,
    fontSize: fontSize.heading,
    lineHeight: fontSize.heading * lineHeight.normal,
  },
  body: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.body,
    lineHeight: fontSize.body * lineHeight.relaxed,
  },
  bodyLarge: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.bodyLarge,
    lineHeight: fontSize.bodyLarge * lineHeight.relaxed,
  },
  caption: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.caption,
    lineHeight: fontSize.caption * lineHeight.normal,
  },
  mono: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.body,
    lineHeight: fontSize.body * lineHeight.normal,
    letterSpacing: 0.2,
  },
  monoSmall: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.caption,
    lineHeight: fontSize.caption * lineHeight.normal,
    letterSpacing: 0.2,
  },
  label: {
    fontFamily: fontFamily.medium,
    fontSize: fontSize.micro,
    lineHeight: fontSize.micro * lineHeight.normal,
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
});
