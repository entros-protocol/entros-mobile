import { StyleSheet, Text } from "react-native";

import { fontFamily } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

interface EntrosLogoProps {
  /** Vertical size of the wordmark glyphs in points. */
  size?: number;
  /** Color override for the wordmark. Defaults to `palette.text`. */
  color?: string;
}

/** Brand wordmark — `entros.` rendered as a single Text element with the
 *  trailing period in cyan. Mirrors `entros.io/src/components/layout/
 *  navbar-wordmark.tsx` visually but uses VT323's own period glyph instead
 *  of a separate inline-block square — the period sits exactly on the text
 *  baseline by virtue of being part of the same line of glyphs, which the
 *  prior `<View>`-based square approach couldn't guarantee on RN's flex
 *  baseline alignment quirks. The shuffle-decrypt animation from the navbar
 *  is intentionally not ported (that's a one-shot home-route reveal). */
export const EntrosLogo = ({ size = 64, color }: EntrosLogoProps) => {
  const { palette } = useTheme();
  return (
    <Text
      style={[styles.wordmark, { fontSize: size, color: color ?? palette.text }]}
      allowFontScaling={false}
      accessibilityRole="image"
      accessibilityLabel="Entros"
    >
      entros<Text style={{ color: palette.accent }}>.</Text>
    </Text>
  );
};

const styles = StyleSheet.create({
  wordmark: {
    fontFamily: fontFamily.wordmark,
    // VT323 ships with generous internal leading; this padding flag tightens
    // the line box on Android so the wordmark doesn't float above its visual
    // bottom edge in centered layouts.
    includeFontPadding: false,
    letterSpacing: -0.5,
  },
});
