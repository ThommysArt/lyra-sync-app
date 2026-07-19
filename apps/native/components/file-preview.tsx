import { Ionicons } from "@expo/vector-icons";
import { Text, View } from "react-native";

import { useAppTheme } from "@/contexts/app-theme-context";
import { fonts } from "@/lib/constants";

type FileInput = { name: string; mimeType?: string | null };

type FileKind =
  | "image"
  | "pdf"
  | "spreadsheet"
  | "text"
  | "code"
  | "archive"
  | "video"
  | "audio"
  | "generic";

const EXT_KIND: Record<string, FileKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
  csv: "spreadsheet",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  txt: "text",
  md: "text",
  json: "code",
  js: "code",
  ts: "code",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  mp4: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
};

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function fileKindOf(file: FileInput): FileKind {
  const mime = (file.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("spreadsheet") || mime.includes("excel") || mime.includes("csv")) {
    return "spreadsheet";
  }
  if (mime.startsWith("text/")) return "text";
  if (mime.includes("zip") || mime.includes("compressed")) return "archive";
  return EXT_KIND[extensionOf(file.name)] ?? "generic";
}

const kindStyle: Record<
  FileKind,
  { icon: keyof typeof Ionicons.glyphMap; badge: string; bgLight: string; bgDark: string; fgLight: string; fgDark: string }
> = {
  image: {
    icon: "image-outline",
    badge: "IMG",
    bgLight: "rgba(14,165,233,0.15)",
    bgDark: "rgba(56,189,248,0.18)",
    fgLight: "#0284c7",
    fgDark: "#38bdf8",
  },
  pdf: {
    icon: "document-text-outline",
    badge: "PDF",
    bgLight: "rgba(239,68,68,0.15)",
    bgDark: "rgba(248,113,113,0.18)",
    fgLight: "#dc2626",
    fgDark: "#f87171",
  },
  spreadsheet: {
    icon: "grid-outline",
    badge: "XLS",
    bgLight: "rgba(16,185,129,0.15)",
    bgDark: "rgba(52,211,153,0.18)",
    fgLight: "#059669",
    fgDark: "#34d399",
  },
  text: {
    icon: "document-outline",
    badge: "TXT",
    bgLight: "rgba(100,116,139,0.15)",
    bgDark: "rgba(148,163,184,0.18)",
    fgLight: "#475569",
    fgDark: "#cbd5e1",
  },
  code: {
    icon: "code-slash-outline",
    badge: "{}",
    bgLight: "rgba(139,92,246,0.15)",
    bgDark: "rgba(167,139,250,0.18)",
    fgLight: "#7c3aed",
    fgDark: "#a78bfa",
  },
  archive: {
    icon: "archive-outline",
    badge: "ZIP",
    bgLight: "rgba(245,158,11,0.15)",
    bgDark: "rgba(251,191,36,0.18)",
    fgLight: "#d97706",
    fgDark: "#fbbf24",
  },
  video: {
    icon: "videocam-outline",
    badge: "VID",
    bgLight: "rgba(217,70,239,0.15)",
    bgDark: "rgba(232,121,249,0.18)",
    fgLight: "#c026d3",
    fgDark: "#e879f9",
  },
  audio: {
    icon: "musical-notes-outline",
    badge: "AUD",
    bgLight: "rgba(249,115,22,0.15)",
    bgDark: "rgba(251,146,60,0.18)",
    fgLight: "#ea580c",
    fgDark: "#fb923c",
  },
  generic: {
    icon: "document-outline",
    badge: "FILE",
    bgLight: "rgba(127,127,127,0.12)",
    bgDark: "rgba(255,255,255,0.08)",
    fgLight: "#6b7280",
    fgDark: "#a3a3a3",
  },
};

export function FilePreview({
  files,
  size = 48,
}: {
  files: FileInput[];
  size?: number;
}) {
  const { isDark } = useAppTheme();
  const primary = files[0];
  const kind = primary ? fileKindOf(primary) : "generic";
  const style = kindStyle[kind];
  const bg = isDark ? style.bgDark : style.bgLight;
  const fg = isDark ? style.fgDark : style.fgLight;
  const count = files.length;

  return (
    <View
      style={{
        alignItems: "center",
        backgroundColor: bg,
        borderRadius: 8,
        height: size,
        justifyContent: "center",
        position: "relative",
        width: size,
      }}
    >
      <Ionicons name={style.icon} size={size * 0.38} color={fg} />
      <Text
        style={{
          color: fg,
          fontFamily: fonts.bold,
          fontSize: 9,
          marginTop: 2,
        }}
      >
        {style.badge}
      </Text>
      {count > 1 ? (
        <View
          style={{
            alignItems: "center",
            backgroundColor: isDark ? "#284167" : "#2f4b79",
            borderRadius: 6,
            minWidth: 16,
            paddingHorizontal: 4,
            position: "absolute",
            right: -4,
            top: -4,
          }}
        >
          <Text style={{ color: "#fff", fontFamily: fonts.semiBold, fontSize: 10 }}>{count}</Text>
        </View>
      ) : null}
    </View>
  );
}
