import { Pressable, View } from "react-native";

/**
 * iOS 26–style capsule switch (matches desktop Lyra switch geometry).
 * Replaces the stock Android/iOS RN Switch look.
 */
export function IosSwitch({
  value,
  onValueChange,
  accent,
  disabled,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  accent: string;
  disabled?: boolean;
}) {
  const trackOff = "rgba(120,120,128,0.32)";
  const trackOn = accent;
  const thumb = "#FFFFFF";

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onValueChange(!value)}
      style={{
        backgroundColor: value ? trackOn : trackOff,
        borderRadius: 999,
        height: 31,
        justifyContent: "center",
        opacity: disabled ? 0.45 : 1,
        paddingHorizontal: 2,
        width: 51,
      }}
    >
      <View
        style={{
          alignSelf: value ? "flex-end" : "flex-start",
          backgroundColor: thumb,
          borderRadius: 999,
          elevation: 2,
          height: 27,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.18,
          shadowRadius: 1.5,
          width: 27,
        }}
      />
    </Pressable>
  );
}
