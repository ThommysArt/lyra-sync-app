import { z } from "zod";

export const DeviceTypeSchema = z.enum(["desktop", "mobile"]);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const PlatformSchema = z.enum([
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
  "web",
  "unknown",
]);
export type Platform = z.infer<typeof PlatformSchema>;

export const ConnectionTypeSchema = z.enum(["local", "tailscale", "both", "manual"]);
export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;

export const NetworkTypeSchema = z.enum([
  "wifi",
  "ethernet",
  "cellular",
  "tailscale",
  "unknown",
]);
export type NetworkType = z.infer<typeof NetworkTypeSchema>;

export const DeviceIdentitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: DeviceTypeSchema,
  platform: PlatformSchema,
  fingerprint: z.string().min(8),
  publicKey: z.string().min(1),
  model: z.string().optional(),
  osVersion: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;

export const DeviceStatusSchema = z.object({
  deviceId: z.string(),
  batteryLevel: z.number().min(0).max(100).nullable(),
  isCharging: z.boolean().nullable(),
  networkType: NetworkTypeSchema,
  networkName: z.string().nullable(),
  freeStorageBytes: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const PairedDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  nickname: z.string().optional(),
  type: DeviceTypeSchema,
  platform: PlatformSchema,
  fingerprint: z.string(),
  publicKey: z.string(),
  model: z.string().optional(),
  osVersion: z.string().optional(),
  pairedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  online: z.boolean(),
  connectionType: ConnectionTypeSchema,
  autoAcceptTransfers: z.boolean(),
  autoAcceptClipboard: z.boolean(),
  showInMainList: z.boolean(),
  status: DeviceStatusSchema.optional(),
  /** Reachability for manual / Tailscale / discovered peers */
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  /**
   * Pairing-derived shared secret for wire auth (never leave device storage).
   * Omitted for demo-seeded peers until a real handshake runs.
   */
  authSecret: z.string().optional(),
  /** Last successful probe latency in ms */
  lastProbeLatencyMs: z.number().nonnegative().optional(),
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

/** Well-known peer listen endpoint (P2 transport). */
export const PeerEndpointSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(53317),
  protocol: z.enum(["http", "https"]).default("http"),
});
export type PeerEndpoint = z.infer<typeof PeerEndpointSchema>;

export const ClipboardContentTypeSchema = z.enum(["text", "image"]);
export type ClipboardContentType = z.infer<typeof ClipboardContentTypeSchema>;

export const ClipboardItemSchema = z.object({
  id: z.string(),
  type: ClipboardContentTypeSchema,
  text: z.string().optional(),
  /** data URL or base64 for images */
  imageData: z.string().optional(),
  sourceDeviceId: z.string(),
  sourceDeviceName: z.string(),
  createdAt: z.number().int().nonnegative(),
  pinned: z.boolean(),
});
export type ClipboardItem = z.infer<typeof ClipboardItemSchema>;

export const TransferDirectionSchema = z.enum(["sent", "received"]);
export type TransferDirection = z.infer<typeof TransferDirectionSchema>;

export const TransferStatusSchema = z.enum([
  "pending",
  "transferring",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "partial",
  /** Waiting for rename / overwrite / skip decision */
  "conflict",
]);
export type TransferStatus = z.infer<typeof TransferStatusSchema>;

export const ConflictActionSchema = z.enum(["rename", "overwrite", "skip"]);
export type ConflictAction = z.infer<typeof ConflictActionSchema>;

export const TransferFileSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string().optional(),
  relativePath: z.string().optional(),
  /** SHA-256 hex of full file contents when available */
  checksum: z.string().optional(),
  /** Bytes already acknowledged (for resume) */
  transferredBytes: z.number().int().nonnegative().optional(),
});
export type TransferFile = z.infer<typeof TransferFileSchema>;

export const TransferSchema = z.object({
  id: z.string(),
  direction: TransferDirectionSchema,
  deviceId: z.string(),
  deviceName: z.string(),
  files: z.array(TransferFileSchema),
  totalBytes: z.number().int().nonnegative(),
  transferredBytes: z.number().int().nonnegative(),
  status: TransferStatusSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  averageSpeedBps: z.number().nonnegative().optional(),
  error: z.string().optional(),
  /** Present when status is `conflict` — primary clashing file (legacy / first) */
  conflictFileName: z.string().optional(),
  /** All clashing file names when multiple files in the session conflict */
  conflictFileNames: z.array(z.string()).optional(),
  conflictResolved: ConflictActionSchema.optional(),
  /** When true, verify file checksums after transfer completes */
  verifyIntegrity: z.boolean().optional(),
  /** Aggregate integrity result after verification */
  integrityOk: z.boolean().optional(),
  /** Resume offset across the session (sum of acknowledged file bytes) */
  resumeOffset: z.number().int().nonnegative().optional(),
});
export type Transfer = z.infer<typeof TransferSchema>;

export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const SmartFolderSchema = z.enum([
  "photos",
  "documents",
  "downloads",
  "desktop",
  "screenshots",
]);
export type SmartFolder = z.infer<typeof SmartFolderSchema>;

export const PairingPayloadSchema = z.object({
  version: z.literal(1),
  deviceId: z.string(),
  name: z.string(),
  type: DeviceTypeSchema,
  platform: PlatformSchema,
  fingerprint: z.string(),
  publicKey: z.string(),
  token: z.string(),
  host: z.string().optional(),
  port: z.number().int().optional(),
  expiresAt: z.number().int().nonnegative(),
});
export type PairingPayload = z.infer<typeof PairingPayloadSchema>;

export const AppSettingsSchema = z.object({
  clipboardHistoryLimit: z.number().int().min(5).max(200).default(40),
  autoAcceptTransfers: z.boolean().default(true),
  autoAcceptClipboard: z.boolean().default(true),
  clipboardSyncEnabled: z.boolean().default(true),
  /**
   * Desktop/web: poll the system clipboard while the app is focused.
   * Mobile keeps manual “Read system” (background clipboard APIs are restricted).
   */
  autoMonitorClipboard: z.boolean().default(false),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  discoveryEnabled: z.boolean().default(true),
  tailscaleEnabled: z.boolean().default(false),
  /** Verify SHA-256 after transfers complete (desktop/native peer path) */
  verifyTransferIntegrity: z.boolean().default(true),
  /** Preferred local peer listen port (Electron / Node peer server) */
  peerListenPort: z.number().int().positive().default(53317),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;
