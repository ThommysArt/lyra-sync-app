import { z } from "zod";

export const LyraMessageTypeSchema = z.enum([
  "pair_request",
  "pair_confirm",
  "pair_reject",
  "unpair",
  "clipboard_push",
  "transfer_offer",
  "transfer_chunk",
  "transfer_pause",
  "transfer_resume",
  "transfer_complete",
  "fs_list",
  "fs_list_response",
  "fs_read",
  "open_url",
  "status",
  "tailscale_peers_request",
  "tailscale_peers_response",
]);

export type LyraMessageType = z.infer<typeof LyraMessageTypeSchema>;

// payload schemas (minimal, wire-compatible) — envelope payload is unknown but we export typed helpers
export const PairRequestPayloadSchema = z.object({
  token: z.string().optional(),
  code: z.string().optional(),
  payload: z.unknown().optional(),
});

export const ClipboardPushPayloadSchema = z.object({
  item: z.object({
    id: z.string(),
    text: z.string(),
    createdAt: z.number(),
  }),
});

export const StatusPayloadSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
});
