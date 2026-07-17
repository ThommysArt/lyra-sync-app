import { LinearGradient } from "expo-linear-gradient";
import type { PropsWithChildren } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

type Edge = "top" | "bottom";

function alpha(color: string, opacity: number): string {
  const hex = color.replace("#", "");
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : hex;
  const value = Number.parseInt(normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

export function ProgressiveBlurEdge({
  backgroundColor,
  children,
  edge,
  fadeHeight,
  style,
}: PropsWithChildren<{
  readonly backgroundColor: string;
  readonly edge: Edge;
  readonly fadeHeight: number;
  readonly style?: ViewStyle;
}>) {
  const fadeColors =
    edge === "top"
      ? ([
          alpha(backgroundColor, 0.98),
          alpha(backgroundColor, 0.82),
          alpha(backgroundColor, 0.45),
          alpha(backgroundColor, 0),
        ] as const)
      : ([
          alpha(backgroundColor, 0),
          alpha(backgroundColor, 0.45),
          alpha(backgroundColor, 0.82),
          alpha(backgroundColor, 0.98),
        ] as const);

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.edge,
        edge === "top" ? styles.top : styles.bottom,
        { minHeight: fadeHeight },
        style,
      ]}
    >
      <LinearGradient
        colors={[...fadeColors]}
        end={{ x: 0.5, y: 1 }}
        locations={[0, 0.28, 0.62, 1]}
        pointerEvents="none"
        start={{ x: 0.5, y: 0 }}
        style={[
          styles.gradient,
          edge === "top"
            ? { height: fadeHeight, top: 0 }
            : { bottom: 0, height: fadeHeight },
        ]}
      />
      <View
        pointerEvents="box-none"
        style={[
          styles.content,
          edge === "top" ? styles.topContent : styles.bottomContent,
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bottom: {
    bottom: 0,
    justifyContent: "flex-end",
  },
  bottomContent: {
    width: "100%",
  },
  content: {
    zIndex: 1,
  },
  edge: {
    left: 0,
    position: "absolute",
    right: 0,
    zIndex: 20,
  },
  gradient: {
    left: 0,
    position: "absolute",
    right: 0,
    zIndex: 0,
  },
  top: {
    top: 0,
  },
  topContent: {
    alignSelf: "flex-start",
    width: "100%",
  },
});
