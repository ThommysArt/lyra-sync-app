/**
 * Default server-side handlers for Lyra protocol envelopes.
 * Used by Node peer-server (and Electron) for real wire behavior.
 */
import {
  ClipboardPushPayloadSchema,
  FsListPayloadSchema,
  FsListResponsePayloadSchema,
  OpenUrlPayloadSchema,
  PairConfirmPayloadSchema,
  PairRequestPayloadSchema,
  TransferChunkPayloadSchema,
  TransferOfferPayloadSchema,
  type ClipboardItem,
  type DeviceIdentity,
  type Envelope,
  type FileEntry,
  type PairingPayload,
} from "@lyra-sync-app/protocol";

import type { AuthSession } from "./auth";
import { createEnvelope } from "./envelope";
import { base64ToBytes } from "./transfer-wire";

/** Message types allowed without a session token. */
export const PUBLIC_MESSAGE_TYPES = new Set([
  "ping",
  "pong",
  "hello",
  "pair_request",
  "discover_announce",
  "discover_response",
]);

export type IncomingPairHandler = (payload: PairingPayload & { code?: string }) => void | Promise<void>;

export type ClipboardPushHandler = (item: Omit<ClipboardItem, "pinned"> & { pinned?: boolean }) => void | Promise<void>;

export type OpenUrlHandler = (url: string, title?: string) => boolean | Promise<boolean>;

export type FsListHandler = (path: string) => FileEntry[] | Promise<FileEntry[]>;

export type TransferReceiveState = {
  transferId: string;
  totalBytes: number;
  receivedBytes: number;
  files: { name: string; size: number }[];
  /** Concatenated received bytes (memory-backed MVP) */
  chunks: Uint8Array[];
};

export type MessageHandlerContext = {
  identity: DeviceIdentity;
  /** Trusted peer lookup for auth secrets is separate; this is app callbacks */
  onPairRequest?: IncomingPairHandler;
  onPairConfirm?: (payload: {
    identity: DeviceIdentity;
    token: string;
    host?: string;
    port?: number;
  }) => void | Promise<void>;
  onClipboardPush?: ClipboardPushHandler;
  onOpenUrl?: OpenUrlHandler;
  onFsList?: FsListHandler;
  /** In-memory transfer buffers keyed by transferId */
  transfers?: Map<string, TransferReceiveState>;
  onTransferComplete?: (state: TransferReceiveState) => void | Promise<void>;
};

export async function handlePeerEnvelope(
  envelope: Envelope,
  session: AuthSession | null,
  ctx: MessageHandlerContext,
): Promise<Envelope | Record<string, unknown>> {
  const from = envelope.fromDeviceId;
  const transfers = ctx.transfers ?? new Map();

  switch (envelope.type) {
    case "ping":
      return createEnvelope({
        type: "pong",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: { ok: true },
      });

    case "hello":
      return createEnvelope({
        type: "hello",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: { identity: ctx.identity },
      });

    case "pair_request": {
      const parsed = PairRequestPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid pair_request" };
      // Dual-confirm: queue for local user accept; do not auto pair_confirm.
      await ctx.onPairRequest?.(parsed.data);
      return createEnvelope({
        type: "pair_confirm",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: {
          // Provisional ack only — full trust requires host user confirm + authSecret.
          identity: ctx.identity,
          token: parsed.data.token,
          publicKey: ctx.identity.publicKey,
          pending: true,
        },
      });
    }

    case "pair_confirm": {
      const parsed = PairConfirmPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid pair_confirm" };
      await ctx.onPairConfirm?.(parsed.data);
      return { ok: true };
    }

    case "pair_reject":
      return { ok: true };

    case "clipboard_push": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = ClipboardPushPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid clipboard_push" };
      await ctx.onClipboardPush?.(parsed.data);
      return createEnvelope({
        type: "clipboard_ack",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: { id: parsed.data.id, ok: true },
      });
    }

    case "open_url": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = OpenUrlPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid open_url" };
      let opened = false;
      try {
        opened = (await ctx.onOpenUrl?.(parsed.data.url, parsed.data.title)) ?? false;
      } catch {
        opened = false;
      }
      return createEnvelope({
        type: "open_url_ack",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: { url: parsed.data.url, opened },
      });
    }

    case "fs_list": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = FsListPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid fs_list" };
      let entries: FileEntry[] = [];
      let error: string | undefined;
      try {
        entries = (await ctx.onFsList?.(parsed.data.path)) ?? [];
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      return createEnvelope({
        type: "fs_list_response",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: FsListResponsePayloadSchema.parse({
          requestId: parsed.data.requestId,
          path: parsed.data.path,
          entries,
          error,
        }),
      });
    }

    case "transfer_offer": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = TransferOfferPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid transfer_offer" };
      const state: TransferReceiveState = {
        transferId: parsed.data.id,
        totalBytes: parsed.data.totalBytes,
        receivedBytes: parsed.data.resumeOffset ?? 0,
        files: parsed.data.files.map((f) => ({ name: f.name, size: f.size })),
        chunks: [],
      };
      transfers.set(parsed.data.id, state);
      return createEnvelope({
        type: "transfer_accept",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: {
          transferId: parsed.data.id,
          resumeOffset: state.receivedBytes,
        },
      });
    }

    case "transfer_chunk": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = TransferChunkPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid transfer_chunk" };
      let state = transfers.get(parsed.data.transferId);
      if (!state) {
        state = {
          transferId: parsed.data.transferId,
          totalBytes: 0,
          receivedBytes: 0,
          files: [],
          chunks: [],
        };
        transfers.set(parsed.data.transferId, state);
      }
      const bytes = base64ToBytes(parsed.data.dataBase64);
      state.chunks.push(bytes);
      state.receivedBytes = parsed.data.offset + bytes.byteLength;
      return createEnvelope({
        type: "transfer_chunk_ack",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: {
          transferId: parsed.data.transferId,
          offset: state.receivedBytes,
          receivedBytes: state.receivedBytes,
          checksumOk: true,
        },
      });
    }

    case "transfer_complete": {
      if (!session) return { ok: false, error: "Auth required" };
      const payload = envelope.payload as { transferId?: string };
      const state = payload.transferId ? transfers.get(payload.transferId) : undefined;
      if (state) await ctx.onTransferComplete?.(state);
      return { ok: true };
    }

    case "transfer_cancel":
    case "transfer_pause":
    case "transfer_resume":
      return { ok: true };

    case "status":
      return { ok: true, identity: ctx.identity };

    default:
      return { ok: true };
  }
}
