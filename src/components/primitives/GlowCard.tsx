// `GlowCard` is now a thin alias over `GlassCard` so every existing call-site
// inherits the premium glassmorphic treatment without an audit-and-rename
// pass. The original GlowCard contract — `glow` for focused state, `padded`,
// `style`, `testID` — flows straight through. New code should import
// `GlassCard` directly and use the additional `intensity` prop where the
// stronger frosted look is wanted (settings DEV PANEL, dashboard score).
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

import { GlassCard } from "./GlassCard";

interface GlowCardProps {
  children: ReactNode;
  glow?: boolean;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const GlowCard = ({
  children,
  glow = false,
  padded = true,
  style,
  testID,
}: GlowCardProps) => (
  <GlassCard glow={glow} padded={padded} style={style} testID={testID}>
    {children}
  </GlassCard>
);
