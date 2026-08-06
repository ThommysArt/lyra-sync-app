import { z } from "zod";

export const LYRA_DEFAULT_PORT = 53317 as const;
export const STORAGE_KEY = "lyra.v2.state" as const;
export const PROTOCOL_VERSION = 2 as const;

// -- primitives ------------------------------------------------------------

export const DeviceTypeSchema = z.enum(["desktop", "mobile", "web", "unknown"]);
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

export const ConnectionTypeSchema = z.enum([
  "wifi",
  "ethernet",
  "bluetooth",
  "cellular",
  "vpn",
  "unknown",
]);
export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;

export const NetworkTypeSchema = z.enum([
  "wifi",
  "cellular",
  "ethernet",
  "unknown",
]);
export type NetworkType = z.infer<typeof NetworkTypeSchema>;

export const DeviceStatusSchema = z.enum([
  "online",
  "offline",
  "away",
  "busy",
  "connecting",
]);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

// -- identity --------------------------------------------------------------

export const DeviceIdentitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: DeviceTypeSchema.optional(),
  platform: PlatformSchema.optional(),
  fingerprint: z.string().min(8),
  publicKey: z.string().optional(),
  model: z.string().optional(),
  osVersion: z.string().optional(),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;

// PairedDevice: extends identity with networking + auth
export const PairedDeviceSchema = DeviceIdentitySchema.extend({
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  tailscaleHost: z.string().optional(),
  preferredAddress: z.string().optional(),
  authSecret: z.string().optional(),
  lastReachableHost: z.string().optional(),
  lastReachablePort: z.number().int().min(1).max(65535).optional(),
  status: DeviceStatusSchema.optional(),
  pairedAt: z.number().optional(),
  lastSeenAt: z.number().optional(),
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

// -- clipboard -------------------------------------------------------------

export const ClipboardItemSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  createdAt: z.number(),
  sourceDeviceId: z.string().optional(),
  type: z.enum(["text", "image"]).default("text").optional(),
  mimeType: z.string().optional(),
});
export type ClipboardItem = z.infer<typeof ClipboardItemSchema>;

// -- transfers -------------------------------------------------------------

export const TransferStatusSchema = z.enum([
  "pending",
  "offered",
  "accepted",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);
export type TransferStatus = z.infer<typeof TransferStatusSchema>;

export const ConflictActionSchema = z.enum([
  "overwrite",
  "skip",
  "rename",
  "ask",
]);
export type ConflictAction = z.infer<typeof ConflictActionSchema>;

export const TransferFileSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  checksum: z.string().optional(),
  relativePath: z.string().optional(),
  mimeType: z.string().optional(),
});
export type TransferFile = z.infer<typeof TransferFileSchema>;

export const TransferSchema = z.object({
  transferId: z.string().min(1),
  files: z.array(TransferFileSchema).min(1),
  totalBytes: z.number().int().nonnegative(),
  status: TransferStatusSchema,
  direction: z.enum(["send", "receive"]).optional(),
  peerDeviceId: z.string().optional(),
  createdAt: z.number().optional(),
  conflictAction: ConflictActionSchema.optional(),
  transferredBytes: z.number().int().nonnegative().optional(),
});
export type Transfer = z.infer<typeof TransferSchema>;

// -- fs --------------------------------------------------------------------

export const FileEntrySchema: z.ZodType<{
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: number;
  children?: Array<z.infer<typeof FileEntrySchema>>;
}> = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  isDirectory: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().optional(),
  children: z.array(z.lazy(() => FileEntrySchema)).optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const SmartFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  icon: z.string().optional(),
});
export type SmartFolder = z.infer<typeof SmartFolderSchema>;

// -- pairing ---------------------------------------------------------------

// keep wire-compatible with v1: version 1 payload
export const PairingPayloadSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]).default(1),
  id: z.string().min(1),
  fingerprint: z.string().min(8),
  publicKey: z.string().optional(),
  name: z.string().min(1),
  platform: PlatformSchema.optional(),
  token: z.string().min(1),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type PairingPayload = z.infer<typeof PairingPayloadSchema>;

// -- settings --------------------------------------------------------------

export const ThemeSchema = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const AppSettingsSchema = z.object({
  clipboardHistoryLimit: z.number().int().min(1).max(1000).default(50),
  clipboardRetentionDays: z.number().int().min(1).max(365).default(30),
  autoAcceptClipboard: z.boolean().default(false),
  autoAcceptFiles: z.boolean().default(false),
  clipboardSyncEnabled: z.boolean().default(true),
  autoMonitorClipboard: z.boolean().default(false),
  discoveryEnabled: z.boolean().default(true),
  tailscaleEnabled: z.boolean().default(true),
  verifyTransferIntegrity: z.boolean().default(true),
  peerListenPort: z.number().int().min(1).max(65535).default(LYRA_DEFAULT_PORT),
  preferHttpsPeer: z.boolean().default(false),
  statusBroadcastEnabled: z.boolean().default(true),
  downloadDirectory: z.string().default(""),
  theme: ThemeSchema.default("system"),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

// -- endpoint --------------------------------------------------------------

export const PeerEndpointSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(LYRA_DEFAULT_PORT),
  tailscaleHost: z.string().optional(),
  preferHttps: z.boolean().optional(),
});
export type PeerEndpoint = z.infer<typeof PeerEndpointSchema>;
