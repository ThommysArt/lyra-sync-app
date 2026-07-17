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
  "pair_request",
  "pair_confirm",
  "pair_reject",
  "clipboard_push",
  "clipboard_ack",
  "transfer_offer",
  "transfer_accept",
  "transfer_progress",
  "transfer_complete",
  "transfer_cancel",
  "transfer_pause",
  "transfer_resume",
  "fs_list",
  "fs_list_response",
  "open_url",
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
});

export const PairRequestPayloadSchema = PairingPayloadSchema;
export const PairConfirmPayloadSchema = z.object({
  identity: DeviceIdentitySchema,
  token: z.string(),
});

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
});

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

export const OpenUrlPayloadSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});
