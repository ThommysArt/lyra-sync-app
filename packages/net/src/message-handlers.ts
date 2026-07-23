/**
 * Default server-side handlers for Lyra protocol envelopes.
 * Used by Node peer-server (and Electron) for real wire behavior.
 */
import {
  ClipboardPushPayloadSchema,
  FsDeletePayloadSchema,
  FsListPayloadSchema,
  FsListResponsePayloadSchema,
  FsMutateAckPayloadSchema,
  FsReadPayloadSchema,
  FsRenamePayloadSchema,
  OpenUrlPayloadSchema,
  PairConfirmPayloadSchema,
  PairRequestPayloadSchema,
  ScreenFramePayloadSchema,
  ScreenShareRequestPayloadSchema,
  ScreenShareStopPayloadSchema,
  TransferChunkPayloadSchema,
  TransferOfferPayloadSchema,
  type ClipboardItem,
  type DeviceIdentity,
  type Envelope,
  type FileEntry,
  type PairingPayload,
  type ScreenFramePayload,
  type ScreenShareAcceptPayload,
  type ScreenShareRequestPayload,
} from "@lyra-sync-app/protocol";

import type { AuthSession } from "./auth";
import { createEnvelope } from "./envelope";
import { base64ToBytes, bytesToBase64 } from "./transfer-wire";

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

/**
 * Optional long-poll gate for pair_request: host UI Accept/Decline.
 * When provided, pair_request waits until this resolves instead of returning a provisional ack.
 */
export type WaitForPairDecision = (payload: PairingPayload & { code?: string }) => Promise<
  | { accepted: true; host?: string; port?: number }
  | { accepted: false; reason?: string }
>;

export type ClipboardPushHandler = (item: Omit<ClipboardItem, "pinned"> & { pinned?: boolean }) => void | Promise<void>;

export type OpenUrlHandler = (url: string, title?: string) => boolean | Promise<boolean>;

export type FsListHandler = (path: string) => FileEntry[] | Promise<FileEntry[]>;

export type TransferReceiveState = {
  transferId: string;
  totalBytes: number;
  receivedBytes: number;
  files: { name: string; size: number }[];
  /** Concatenated received bytes (memory-backed for small transfers) */
  chunks: Uint8Array[];
  /** When true, further chunks are rejected until resume */
  paused?: boolean;
  /** Offered checksums for integrity (file index → hex) */
  checksums?: (string | undefined)[];
  /** Disk-backed path when large transfer uses temp file */
  diskPath?: string;
  /** Append callback for disk mode (set by peer-server / Node) */
  appendChunk?: (bytes: Uint8Array, offset: number) => Promise<void>;
  finalizeDisk?: () => Promise<{ sha256?: string; size: number; filePath: string }>;
  cleanupDisk?: () => Promise<void>;
};

/** Prefer disk when total bytes exceed this threshold (1 MiB). */
export const DISK_TRANSFER_THRESHOLD = 1024 * 1024;

export type FsReadHandler = (
  path: string,
  offset: number,
  maxBytes: number,
) => Promise<{ data: Uint8Array; eof: boolean; size: number }> | {
  data: Uint8Array;
  eof: boolean;
  size: number;
};

export type FsDeleteHandler = (path: string) => void | Promise<void>;
export type FsRenameHandler = (path: string, newName: string) => string | Promise<string>;

export type ScreenShareRequestHandler = (
  request: ScreenShareRequestPayload,
  fromDeviceId: string,
) =>
  | Promise<ScreenShareAcceptPayload | { reject: true; reason: string }>
  | ScreenShareAcceptPayload
  | { reject: true; reason: string };

export type ScreenFrameHandler = (
  frame: ScreenFramePayload,
  fromDeviceId: string,
) => void | Promise<void>;

export type ScreenShareStopHandler = (
  sessionId: string,
  fromDeviceId: string,
  reason?: string,
) => void | Promise<void>;

export type MessageHandlerContext = {
  identity: DeviceIdentity;
  /** Trusted peer lookup for auth secrets is separate; this is app callbacks */
  onPairRequest?: IncomingPairHandler;
  /**
   * When set, pair_request blocks until the host user Accepts/Declines.
   * Used for code-based same-network pairing.
   */
  waitForPairDecision?: WaitForPairDecision;
  onPairConfirm?: (payload: {
    identity: DeviceIdentity;
    token: string;
    host?: string;
    port?: number;
  }) => void | Promise<void>;
  /** Remote peer unpaired us — drop local trust */
  onUnpair?: (deviceId: string) => void | Promise<void>;
  onClipboardPush?: ClipboardPushHandler;
  onOpenUrl?: OpenUrlHandler;
  onFsList?: FsListHandler;
  onFsRead?: FsReadHandler;
  onFsDelete?: FsDeleteHandler;
  onFsRename?: FsRenameHandler;
  /** Incoming screen share request (we are the source). */
  onScreenShareRequest?: ScreenShareRequestHandler;
  /** Incoming frame while we are the viewer. */
  onScreenFrame?: ScreenFrameHandler;
  /** Peer stopped sharing. */
  onScreenShareStop?: ScreenShareStopHandler;
  /**
   * Optional factory for disk-backed receive state (Node peer server).
   * When omitted, small transfers stay in memory.
   */
  createDiskTransfer?: (input: {
    transferId: string;
    totalBytes: number;
    files: { name: string; size: number }[];
    resumeOffset?: number;
    checksums?: (string | undefined)[];
  }) => Promise<TransferReceiveState>;
  /** In-memory / disk transfer buffers keyed by transferId */
  transfers?: Map<string, TransferReceiveState>;
  onTransferComplete?: (state: TransferReceiveState) => void | Promise<void>;
  /** Drop sessions for device (server wires this) */
  revokeDeviceSessions?: (deviceId: string) => number;
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
      // Register long-poll waiter first so Accept cannot race past it, then notify UI.
      if (ctx.waitForPairDecision) {
        const decisionPromise = ctx.waitForPairDecision(parsed.data);
        await ctx.onPairRequest?.(parsed.data);
        const decision = await decisionPromise;
        if (!decision.accepted) {
          return createEnvelope({
            type: "pair_reject",
            fromDeviceId: ctx.identity.id,
            toDeviceId: from,
            payload: {
              deviceId: ctx.identity.id,
              reason: decision.reason ?? "rejected",
            },
          });
        }
        return createEnvelope({
          type: "pair_confirm",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: {
            identity: ctx.identity,
            token: parsed.data.token,
            publicKey: ctx.identity.publicKey,
            host: decision.host,
            port: decision.port,
          },
        });
      }
      // No long-poll gate (e.g. unit tests): notify + confirm immediately.
      await ctx.onPairRequest?.(parsed.data);
      return createEnvelope({
        type: "pair_confirm",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: {
          identity: ctx.identity,
          token: parsed.data.token,
          publicKey: ctx.identity.publicKey,
        },
      });
    }

    case "pair_confirm": {
      const parsed = PairConfirmPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid pair_confirm" };
      await ctx.onPairConfirm?.(parsed.data);
      return { ok: true };
    }

    case "pair_reject": {
      const payload = envelope.payload as { deviceId?: string; reason?: string };
      const peerId = payload.deviceId ?? from;
      ctx.revokeDeviceSessions?.(peerId);
      await ctx.onUnpair?.(peerId);
      return { ok: true, revoked: true };
    }

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

    case "screen_share_request": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = ScreenShareRequestPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid screen_share_request" };
      if (!ctx.onScreenShareRequest) {
        return createEnvelope({
          type: "screen_share_reject",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: {
            sessionId: parsed.data.sessionId,
            reason: "Screen share not supported on this peer",
          },
        });
      }
      const decision = await ctx.onScreenShareRequest(parsed.data, from);
      if ("reject" in decision && decision.reject) {
        return createEnvelope({
          type: "screen_share_reject",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: {
            sessionId: parsed.data.sessionId,
            reason: decision.reason,
          },
        });
      }
      const accept = decision as ScreenShareAcceptPayload;
      return createEnvelope({
        type: "screen_share_accept",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: accept,
      });
    }

    case "screen_frame": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = ScreenFramePayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid screen_frame" };
      await ctx.onScreenFrame?.(parsed.data, from);
      return { ok: true, seq: parsed.data.seq };
    }

    case "screen_share_stop": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = ScreenShareStopPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid screen_share_stop" };
      await ctx.onScreenShareStop?.(parsed.data.sessionId, from, parsed.data.reason);
      return { ok: true };
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

    case "fs_read": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = FsReadPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid fs_read" };
      try {
        if (!ctx.onFsRead) {
          return createEnvelope({
            type: "fs_read_response",
            fromDeviceId: ctx.identity.id,
            toDeviceId: from,
            payload: {
              requestId: parsed.data.requestId,
              path: parsed.data.path,
              offset: parsed.data.offset,
              eof: true,
              error: "fs_read not supported on this peer",
            },
          });
        }
        const result = await ctx.onFsRead(
          parsed.data.path,
          parsed.data.offset,
          parsed.data.maxBytes,
        );
        return createEnvelope({
          type: "fs_read_response",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: {
            requestId: parsed.data.requestId,
            path: parsed.data.path,
            offset: parsed.data.offset,
            dataBase64: bytesToBase64(result.data),
            eof: result.eof,
            size: result.size,
          },
        });
      } catch (e) {
        return createEnvelope({
          type: "fs_read_response",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: {
            requestId: parsed.data.requestId,
            path: parsed.data.path,
            offset: parsed.data.offset,
            eof: true,
            error: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }

    case "fs_delete": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = FsDeletePayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid fs_delete" };
      try {
        await ctx.onFsDelete?.(parsed.data.path);
        return createEnvelope({
          type: "fs_mutate_ack",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: FsMutateAckPayloadSchema.parse({
            requestId: parsed.data.requestId,
            ok: true,
            path: parsed.data.path,
          }),
        });
      } catch (e) {
        return createEnvelope({
          type: "fs_mutate_ack",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: {
            requestId: parsed.data.requestId,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }

    case "fs_rename": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = FsRenamePayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid fs_rename" };
      try {
        const newPath = await ctx.onFsRename?.(parsed.data.path, parsed.data.newName);
        return createEnvelope({
          type: "fs_mutate_ack",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: {
            requestId: parsed.data.requestId,
            ok: true,
            path: newPath ?? parsed.data.path,
          },
        });
      } catch (e) {
        return createEnvelope({
          type: "fs_mutate_ack",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: {
            requestId: parsed.data.requestId,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }

    case "transfer_offer": {
      if (!session) return { ok: false, error: "Auth required" };
      const parsed = TransferOfferPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return { ok: false, error: "Invalid transfer_offer" };
      const files = parsed.data.files.map((f) => ({ name: f.name, size: f.size }));
      const checksums = parsed.data.files.map((f) => f.checksum);
      let state: TransferReceiveState;
      if (
        ctx.createDiskTransfer &&
        parsed.data.totalBytes >= DISK_TRANSFER_THRESHOLD
      ) {
        state = await ctx.createDiskTransfer({
          transferId: parsed.data.id,
          totalBytes: parsed.data.totalBytes,
          files,
          resumeOffset: parsed.data.resumeOffset,
          checksums,
        });
      } else {
        state = {
          transferId: parsed.data.id,
          totalBytes: parsed.data.totalBytes,
          receivedBytes: parsed.data.resumeOffset ?? 0,
          files,
          chunks: [],
          paused: false,
          checksums,
        };
      }
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
          paused: false,
        };
        transfers.set(parsed.data.transferId, state);
      }
      if (state.paused) {
        return createEnvelope({
          type: "transfer_pause",
          fromDeviceId: ctx.identity.id,
          toDeviceId: from,
          payload: {
            transferId: parsed.data.transferId,
            receivedBytes: state.receivedBytes,
          },
        });
      }
      const bytes = base64ToBytes(parsed.data.dataBase64);
      if (state.appendChunk) {
        try {
          await state.appendChunk(bytes, parsed.data.offset);
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : "Disk write failed",
          };
        }
      } else {
        state.chunks.push(bytes);
        state.receivedBytes = parsed.data.offset + bytes.byteLength;
      }
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
      if (state) {
        if (state.finalizeDisk) {
          const fin = await state.finalizeDisk();
          if (
            state.files.length === 1 &&
            state.checksums?.[0] &&
            fin.sha256
          ) {
            const { checksumsMatch } = await import("./integrity");
            if (!checksumsMatch(state.checksums[0], fin.sha256)) {
              await state.cleanupDisk?.();
              return { ok: false, error: "Integrity check failed", integrityOk: false };
            }
          }
          state.diskPath = fin.filePath;
        } else if (state.checksums?.some(Boolean) && state.chunks.length > 0) {
          const { checksumBytes, checksumsMatch } = await import("./integrity");
          const totalLen = state.chunks.reduce(
            (a: number, c: Uint8Array) => a + c.byteLength,
            0,
          );
          const merged = new Uint8Array(totalLen);
          let o = 0;
          for (const c of state.chunks) {
            merged.set(c, o);
            o += c.byteLength;
          }
          if (state.files.length === 1 && state.checksums[0]) {
            const actual = await checksumBytes(merged);
            if (!checksumsMatch(state.checksums[0], actual)) {
              return { ok: false, error: "Integrity check failed", integrityOk: false };
            }
          }
        }
        await ctx.onTransferComplete?.(state);
      }
      return { ok: true, integrityOk: true };
    }

    case "transfer_cancel": {
      const payload = envelope.payload as { transferId?: string };
      if (payload.transferId) {
        const state = transfers.get(payload.transferId);
        await state?.cleanupDisk?.();
        transfers.delete(payload.transferId);
      }
      return { ok: true };
    }

    case "status":
      return {
        ok: true,
        identity: ctx.identity,
        status: envelope.payload,
      };

    case "transfer_pause": {
      if (!session) return { ok: false, error: "Auth required" };
      const payload = envelope.payload as { transferId?: string };
      const state = payload.transferId ? transfers.get(payload.transferId) : undefined;
      if (state) state.paused = true;
      return {
        ok: true,
        paused: true,
        receivedBytes: state?.receivedBytes ?? 0,
      };
    }

    case "transfer_resume": {
      if (!session) return { ok: false, error: "Auth required" };
      const payload = envelope.payload as { transferId?: string; offset?: number };
      const state = payload.transferId ? transfers.get(payload.transferId) : undefined;
      if (state) {
        state.paused = false;
        if (typeof payload.offset === "number") {
          state.receivedBytes = payload.offset;
        }
      }
      return createEnvelope({
        type: "transfer_accept",
        fromDeviceId: ctx.identity.id,
        toDeviceId: from,
        payload: {
          transferId: payload.transferId ?? "",
          resumeOffset: state?.receivedBytes ?? payload.offset ?? 0,
        },
      });
    }

    default:
      return { ok: true };
  }
}
