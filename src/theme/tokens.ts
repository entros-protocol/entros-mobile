// Visual tokens for entros-mobile. Mobile and web each tune these for their
// own surface — pure black on mobile reads cleaner against the e. logo;
// `#0A0A0F` on web reads cleaner against full-bleed gradient sections.
// Keep accent + Solana brand colors in sync across platforms; treat surface
// and background as platform-tuned.
//
// Typography is JetBrains Mono everywhere. The four weights below match the
// `@expo-google-fonts/jetbrains-mono` exports and are loaded once in
// `app/_layout.tsx`.
export type Mode = "dark" | "light";

export interface Palette {
  background: string;
  surface: string;
  surfaceHover: string;
  border: string;
  borderFocus: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  accent: string;
  accentMuted: string;
  solanaPurple: string;
  solanaGreen: string;
  warning: string;
  danger: string;
  glow: string;
}

const dark: Palette = {
  background: "#000000",
  surface: "#0E0E14",
  surfaceHover: "#16161E",
  border: "rgba(255, 255, 255, 0.06)",
  borderFocus: "rgba(34, 211, 230, 0.35)",
  text: "#E8E6E0",
  textMuted: "#858595",
  textSubtle: "#3A3A48",
  accent: "#22D3E6",
  accentMuted: "rgba(34, 211, 230, 0.16)",
  solanaPurple: "#A855F7",
  solanaGreen: "#14F195",
  warning: "#FFB800",
  danger: "#FF3B3B",
  glow: "rgba(34, 211, 230, 0.18)",
};

const light: Palette = {
  background: "#FAFAF8",
  surface: "#F0F0EC",
  surfaceHover: "#E6E6E0",
  border: "rgba(0, 0, 0, 0.08)",
  borderFocus: "rgba(10, 173, 188, 0.4)",
  text: "#1A1A1F",
  textMuted: "#5A5A6A",
  textSubtle: "#B0B0BA",
  accent: "#0AADBC",
  accentMuted: "rgba(10, 173, 188, 0.12)",
  solanaPurple: "#7C3AED",
  solanaGreen: "#059669",
  warning: "#D97706",
  danger: "#DC2626",
  glow: "rgba(10, 173, 188, 0.15)",
};

export const palettes: Record<Mode, Palette> = { dark, light };

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  hero: 48,
  page: 64,
} as const;

export const radii = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
  pill: 999,
} as const;

// JetBrains Mono in four weights. Loaded by useFonts in app/_layout.tsx.
// The weight names below must exactly match the keys we pass to useFonts.
export const fontFamily = {
  regular: "JetBrainsMono_400Regular",
  medium: "JetBrainsMono_500Medium",
  semiBold: "JetBrainsMono_600SemiBold",
  bold: "JetBrainsMono_700Bold",
} as const;

export const fontSize = {
  micro: 11,
  caption: 12,
  small: 13,
  body: 15,
  bodyLarge: 17,
  heading: 22,
  title: 28,
  display: 36,
  hero: 48,
} as const;

export const lineHeight = {
  tight: 1.2,
  normal: 1.45,
  relaxed: 1.6,
} as const;
