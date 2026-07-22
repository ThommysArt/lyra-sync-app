import { z } from "zod";

import {
  ClipboardItemSchema,
  DeviceIdentitySchema,
  DeviceStatusSchema,
  FileEntrySchema,
  PairingPayloadSchema,
  TransferSchema,
} from "./schemas";

/** Shared peer protocol envelope — validated with Zod on both sides. */
export const MessageTypeSchema = z.enum([
  "hello",
  "status",
  "discover_announce",
  "discover_response",
  "pair_request",
  "pair_confirm",
  "pair_reject",
  "auth_challenge",
  "auth_response",
  "auth_ok",
  "auth_fail",
  "clipboard_push",
  "clipboard_ack",
  "transfer_offer",
  "transfer_accept",
  "transfer_progress",
  "transfer_complete",
  "transfer_cancel",
  "transfer_pause",
  "transfer_resume",
  "transfer_chunk",
  "transfer_chunk_ack",
  "fs_list",
  "fs_list_response",
  "fs_read",
  "fs_read_response",
  "fs_delete",
  "fs_rename",
  "fs_mutate_ack",
  "open_url",
  "open_url_ack",
  /** Viewer asks source to start streaming screen frames (Sefirah/scrcpy-inspired). */
  "screen_share_request",
  "screen_share_accept",
  "screen_share_reject",
  "screen_share_stop",
  /** JPEG/WebP frame payload from source → viewer. */
  "screen_frame",
  "ping",
  "pong",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const EnvelopeSchema = z.object({
  id: z.string(),
  type: MessageTypeSchema,
  fromDeviceId: z.string(),
  toDeviceId: z.string().optional(),
  timestamp: z.number().int().nonnegative(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const HelloPayloadSchema = z.object({
  identity: DeviceIdentitySchema,
  status: DeviceStatusSchema.optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
});

/** Multicast / LAN announce (P2 discovery) — LocalSend-style announce flag. */
export const DiscoverAnnouncePayloadSchema = z.object({
  identity: DeviceIdentitySchema.pick({
    id: true,
    name: true,
    type: true,
    platform: true,
    fingerprint: true,
    publicKey: true,
  }),
  host: z.string().min(1),
  port: z.number().int().positive(),
  protocolVersion: z.number().int().positive(),
  /**
   * When true, receivers should reply so the announcer also learns about them
   * (LocalSend dual-visibility handshake).
   */
  announce: z.boolean().optional(),
  /**
   * Optional active pairing offer (code hash only — never raw code).
   * Lets joiners match a short code from discovery without a full subnet scan.
   */
  pairing: z
    .object({
      codeHash: z.string().min(8),
      token: z.string().min(1),
      expiresAt: z.number().int().nonnegative(),
    })
    .optional(),
});
export type DiscoverAnnouncePayload = z.infer<typeof DiscoverAnnouncePayloadSchema>;

export const PairRequestPayloadSchema = PairingPayloadSchema.extend({
  /** Optional code so the host can match an active pairing session */
  code: z.string().optional(),
});
export type PairRequestPayload = z.infer<typeof PairRequestPayloadSchema>;

export const PairConfirmPayloadSchema = z.object({
  identity: DeviceIdentitySchema,
  token: z.string(),
  /** Confirmer public key (redundant with identity, kept for clarity) */
  publicKey: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
});
export type PairConfirmPayload = z.infer<typeof PairConfirmPayloadSchema>;

export const ClipboardPushPayloadSchema = ClipboardItemSchema.omit({
  pinned: true,
}).extend({
  pinned: z.boolean().optional(),
});

export const TransferOfferPayloadSchema = TransferSchema.pick({
  id: true,
  files: true,
  totalBytes: true,
  deviceId: true,
  deviceName: true,
}).extend({
  /** Optional per-file SHA-256 hex for integrity verification */
  checksums: z.array(z.string()).optional(),
  /** Resume from byte offset when partial data already exists */
  resumeOffset: z.number().int().nonnegative().optional(),
});

/** Auth challenge: prove knowledge of the private key bound to a fingerprint. */
export const AuthChallengePayloadSchema = z.object({
  challengeId: z.string().min(1),
  nonce: z.string().min(8),
  /** Server fingerprint the client should expect */
  serverFingerprint: z.string().min(8),
  expiresAt: z.number().int().nonnegative(),
});
export type AuthChallengePayload = z.infer<typeof AuthChallengePayloadSchema>;

export const AuthResponsePayloadSchema = z.object({
  challengeId: z.string().min(1),
  deviceId: z.string().min(1),
  fingerprint: z.string().min(8),
  publicKey: z.string().min(1),
  /** HMAC-style proof: hex(sha256(nonce + privateKey material)) */
  proof: z.string().min(8),
});
export type AuthResponsePayload = z.infer<typeof AuthResponsePayloadSchema>;

export const AuthOkPayloadSchema = z.object({
  sessionToken: z.string().min(1),
  deviceId: z.string().min(1),
  fingerprint: z.string().min(8),
  expiresAt: z.number().int().nonnegative(),
});
export type AuthOkPayload = z.infer<typeof AuthOkPayloadSchema>;

export const TransferResumePayloadSchema = z.object({
  transferId: z.string().min(1),
  /** Bytes already received/stored on the destination */
  offset: z.number().int().nonnegative(),
  /** Optional expected checksum of the full file for integrity */
  expectedChecksum: z.string().optional(),
});
export type TransferResumePayload = z.infer<typeof TransferResumePayloadSchema>;

export const TransferChunkPayloadSchema = z.object({
  transferId: z.string().min(1),
  fileIndex: z.number().int().nonnegative().default(0),
  /** Absolute byte offset within the session (sum of prior files + offset in current) */
  offset: z.number().int().nonnegative(),
  /** Base64-encoded chunk body */
  dataBase64: z.string(),
  /** True when this is the last chunk of the full transfer session */
  eof: z.boolean().optional(),
  /** Optional running checksum of full file when eof for that file */
  checksum: z.string().optional(),
});
export type TransferChunkPayload = z.infer<typeof TransferChunkPayloadSchema>;

export const TransferChunkAckPayloadSchema = z.object({
  transferId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  receivedBytes: z.number().int().nonnegative(),
  checksumOk: z.boolean().optional(),
});
export type TransferChunkAckPayload = z.infer<typeof TransferChunkAckPayloadSchema>;

export const FsListPayloadSchema = z.object({
  path: z.string(),
  requestId: z.string(),
});

export const FsListResponsePayloadSchema = z.object({
  requestId: z.string(),
  path: z.string(),
  entries: z.array(FileEntrySchema),
  error: z.string().optional(),
});

export const FsReadPayloadSchema = z.object({
  path: z.string(),
  requestId: z.string(),
  /** Byte offset for large files */
  offset: z.number().int().nonnegative().default(0),
  /** Max bytes to return in this chunk (default 256 KiB) */
  maxBytes: z.number().int().positive().max(1024 * 1024).default(256 * 1024),
});
export type FsReadPayload = z.infer<typeof FsReadPayloadSchema>;

export const FsReadResponsePayloadSchema = z.object({
  requestId: z.string(),
  path: z.string(),
  offset: z.number().int().nonnegative(),
  dataBase64: z.string().optional(),
  eof: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type FsReadResponsePayload = z.infer<typeof FsReadResponsePayloadSchema>;

export const FsDeletePayloadSchema = z.object({
  path: z.string(),
  requestId: z.string(),
});

export const FsRenamePayloadSchema = z.object({
  path: z.string(),
  newName: z.string().min(1),
  requestId: z.string(),
});

export const FsMutateAckPayloadSchema = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  path: z.string().optional(),
});

export const OpenUrlPayloadSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});
export type OpenUrlPayload = z.infer<typeof OpenUrlPayloadSchema>;

export const OpenUrlAckPayloadSchema = z.object({
  url: z.string(),
  opened: z.boolean(),
  error: z.string().optional(),
});
export type OpenUrlAckPayload = z.infer<typeof OpenUrlAckPayloadSchema>;

/** Viewer → source: start a screen share session. */
export const ScreenShareRequestPayloadSchema = z.object({
  sessionId: z.string().min(1),
  /** Preferred max long-edge pixels (default 720). */
  maxEdge: z.number().int().positive().max(1920).default(720),
  /** Preferred frames per second (soft cap). */
  fps: z.number().int().positive().max(30).default(12),
  /** JPEG quality 0–1 when source encodes JPEG. */
  quality: z.number().min(0.1).max(1).default(0.72),
});
export type ScreenShareRequestPayload = z.infer<typeof ScreenShareRequestPayloadSchema>;

export const ScreenShareAcceptPayloadSchema = z.object({
  sessionId: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().int().positive().optional(),
  /** Source capability notes for UI. */
  mode: z.enum(["p2p", "scrcpy", "demo", "unavailable"]).default("p2p"),
  mimeType: z.enum(["image/jpeg", "image/webp", "image/png"]).default("image/jpeg"),
});
export type ScreenShareAcceptPayload = z.infer<typeof ScreenShareAcceptPayloadSchema>;

export const ScreenShareRejectPayloadSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.string().min(1),
});
export type ScreenShareRejectPayload = z.infer<typeof ScreenShareRejectPayloadSchema>;

export const ScreenShareStopPayloadSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.string().optional(),
});
export type ScreenShareStopPayload = z.infer<typeof ScreenShareStopPayloadSchema>;

export const ScreenFramePayloadSchema = z.object({
  sessionId: z.string().min(1),
  /** Monotonic frame sequence. */
  seq: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: z.enum(["image/jpeg", "image/webp", "image/png"]).default("image/jpeg"),
  /** Base64 image body (no data-URL prefix). */
  dataBase64: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
});
export type ScreenFramePayload = z.infer<typeof ScreenFramePayloadSchema>;
