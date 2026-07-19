import { useMemo } from "react";
import {
  Archive,
  File,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type FilePreviewInput = {
  name: string;
  mimeType?: string | null;
  /** Object URL or data URL for image preview when available */
  previewUrl?: string | null;
};

export type FileKind =
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
  avif: "image",
  svg: "image",
  heic: "image",
  pdf: "pdf",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ods: "spreadsheet",
  txt: "text",
  md: "text",
  rtf: "text",
  log: "text",
  json: "code",
  js: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  py: "code",
  rs: "code",
  go: "code",
  html: "code",
  css: "code",
  xml: "code",
  yaml: "code",
  yml: "code",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  m4a: "audio",
  ogg: "audio",
};

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i < 0) return "";
  return name.slice(i + 1).toLowerCase();
}

export function fileKindOf(file: Pick<FilePreviewInput, "name" | "mimeType">): FileKind {
  const mime = (file.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime === "text/csv" ||
    mime.includes("csv")
  ) {
    return "spreadsheet";
  }
  if (mime.startsWith("text/")) return "text";
  if (
    mime.includes("zip") ||
    mime.includes("compressed") ||
    mime.includes("tar") ||
    mime.includes("gzip")
  ) {
    return "archive";
  }
  if (
    mime.includes("json") ||
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    mime.includes("xml")
  ) {
    return "code";
  }
  return EXT_KIND[extensionOf(file.name)] ?? "generic";
}

const kindMeta: Record<
  FileKind,
  { label: string; Icon: typeof File; className: string; badge?: string }
> = {
  image: { label: "IMG", Icon: FileImage, className: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  pdf: {
    label: "PDF",
    Icon: FileText,
    className: "bg-red-500/15 text-red-600 dark:text-red-400",
    badge: "PDF",
  },
  spreadsheet: {
    label: "XLS",
    Icon: FileSpreadsheet,
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    badge: "XLS",
  },
  text: {
    label: "TXT",
    Icon: FileText,
    className: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
    badge: "TXT",
  },
  code: {
    label: "CODE",
    Icon: FileCode2,
    className: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    badge: "{}",
  },
  archive: {
    label: "ZIP",
    Icon: Archive,
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    badge: "ZIP",
  },
  video: {
    label: "VID",
    Icon: FileVideo,
    className: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
  },
  audio: {
    label: "AUD",
    Icon: FileAudio,
    className: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  },
  generic: {
    label: "FILE",
    Icon: File,
    className: "bg-muted text-muted-foreground",
  },
};

/**
 * Left-side transfer/file thumb: real image when possible, otherwise a type mock.
 */
export function FilePreview({
  file,
  files,
  className,
  size = "md",
}: {
  file?: FilePreviewInput | null;
  /** Multi-file: show first + count badge */
  files?: FilePreviewInput[];
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const primary = file ?? files?.[0] ?? null;
  const count = files?.length ?? (file ? 1 : 0);
  const kind = useMemo(
    () => (primary ? fileKindOf(primary) : "generic"),
    [primary],
  );
  const meta = kindMeta[kind];
  const Icon = meta.Icon;
  const dim = size === "sm" ? "size-10" : size === "lg" ? "size-14" : "size-12";
  const iconSize = size === "sm" ? "size-4" : size === "lg" ? "size-6" : "size-5";

  if (!primary) {
    return (
      <div
        className={cn(
          "relative flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground",
          dim,
          className,
        )}
      >
        <File className={iconSize} />
      </div>
    );
  }

  const showImage = kind === "image" && primary.previewUrl;

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-md ring-1 ring-border/60",
        dim,
        !showImage && meta.className,
        className,
      )}
      title={primary.name}
    >
      {showImage ? (
        <img
          src={primary.previewUrl!}
          alt=""
          className="size-full object-cover"
          loading="lazy"
        />
      ) : meta.badge ? (
        <div className="flex flex-col items-center gap-0.5">
          <Icon className={iconSize} strokeWidth={1.75} />
          <span className="text-[9px] font-bold tracking-wide opacity-90">{meta.badge}</span>
        </div>
      ) : (
        <Icon className={iconSize} strokeWidth={1.75} />
      )}
      {count > 1 ? (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-md bg-secondary px-1 text-[10px] font-semibold text-secondary-foreground shadow-sm">
          {count}
        </span>
      ) : null}
    </div>
  );
}
