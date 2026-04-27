import { Image, StyleSheet, View } from "react-native";

interface EntrosLogoProps {
  size?: number;
}

// The wordmark / mark lives at assets/entros.png. Using <Image source={require()}>
// so Metro bundles it as a static asset.
export const EntrosLogo = ({ size = 140 }: EntrosLogoProps) => (
  <View style={[styles.wrap, { width: size, height: size }]}>
    <Image
      source={require("../../../assets/entros.png")}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="Entros"
    />
  </View>
);

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
  },
});
