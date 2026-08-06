/**
 * Host-side screen share: permission dialogs + getDisplayMedia capture loop.
 *
 * Desktop peer server forwards screen_share_request here via IPC.
 * Browser: not applicable (no peer server). Demo frames remain client-only.
 */

import { wireSendScreenFrame } from "@lyra-sync-app/core";
import { MonitorUp, Smartphone } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@lyra-sync-app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lyra-sync-app/ui/components/dialog";
import { getDesktopApi } from "@/lib/desktop-bridge";
import { formatCaptureError, startDisplayCapture, type DisplayCaptureHandle } from "@/lib/screen-capture";
import { useLyraStore } from "@/lib/lyra";

type IncomingShare = {
  request: {
    sessionId: string;
    maxEdge?: number;
    fps?: number;
    quality?: number;
  };
  fromDeviceId: string;
  fromName?: string;
};

export function ScreenShareHost() {
  const store = useLyraStore();
  const [incoming, setIncoming] = useState<IncomingShare | null>(null);
  const [busy, setBusy] = useState(false);
  const captureRef = useRef<DisplayCaptureHandle | null>(null);
  const activeSessionRef = useRef<{
    sessionId: string;
    deviceId: string;
    seq: number;
  } | null>(null);

  const stopCapture = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    activeSessionRef.current = null;
  }, []);

  // Incoming request from Electron peer server
  useEffect(() => {
    const api = getDesktopApi();
    if (!api?.onScreenShareRequest) return;

    const unsub = api.onScreenShareRequest((payload) => {
      const device = store.getState().devices.find((d) => d.id === payload.fromDeviceId);
      setIncoming({
        request: payload.request,
        fromDeviceId: payload.fromDeviceId,
        fromName: device?.nickname || device?.name || payload.fromDeviceId.slice(0, 8),
      });
    });

    return () => {
      unsub();
      stopCapture();
    };
  }, [store, stopCapture]);

  // Peer stop / local stop
  useEffect(() => {
    const api = getDesktopApi();
    if (!api?.onScreenShareStop) return;
    return api.onScreenShareStop(({ sessionId }) => {
      if (activeSessionRef.current?.sessionId === sessionId) {
        stopCapture();
        toast.message("Screen share stopped by peer");
      }
    });
  }, [stopCapture]);

  const decline = async (reason = "User declined screen share") => {
    if (!incoming) return;
    const api = getDesktopApi();
    await api?.respondScreenShare?.({
      sessionId: incoming.request.sessionId,
      accepted: false,
      reason,
    });
    setIncoming(null);
  };

  const accept = async () => {
    if (!incoming) return;
    setBusy(true);
    const api = getDesktopApi();
    const req = incoming.request;
    const viewerId = incoming.fromDeviceId;

    try {
      // Start capture first so we only accept if the OS picker succeeds
      const handle = await startDisplayCapture({
        maxEdge: req.maxEdge ?? 720,
        fps: req.fps ?? 12,
        quality: req.quality ?? 0.72,
        onFrame: (frame) => {
          const cur = activeSessionRef.current;
          if (!cur || cur.sessionId !== req.sessionId) return;
          cur.seq += 1;
          const s = store.getState();
          const device = s.devices.find((d) => d.id === viewerId);
          if (!device || !s.identity || !s.privateKey || !device.authSecret) return;
          // Fire-and-forget frame push (drop if slow)
          void wireSendScreenFrame({
            device,
            identity: s.identity,
            privateKey: s.privateKey,
            frame: {
              sessionId: req.sessionId,
              seq: cur.seq,
              width: frame.width,
              height: frame.height,
              mimeType: frame.mimeType,
              dataBase64: frame.dataBase64,
              capturedAt: frame.capturedAt,
            },
          });
          // Local preview of what we are sending
          store.ingestScreenFrame(viewerId, {
            sessionId: req.sessionId,
            seq: cur.seq,
            width: frame.width,
            height: frame.height,
            mimeType: frame.mimeType,
            dataBase64: frame.dataBase64,
            capturedAt: frame.capturedAt,
          });
        },
        onError: (msg) => toast.error(msg),
        onEnded: () => {
          stopCapture();
          toast.message("Screen capture ended");
        },
      });

      captureRef.current = handle;
      activeSessionRef.current = {
        sessionId: req.sessionId,
        deviceId: viewerId,
        seq: 0,
      };

      // Mark local source session
      const now = Date.now();
      store.getState(); // ensure store ready
      // Soft local session via start is viewer-only; track source via ingest after accept

      await api?.respondScreenShare?.({
        sessionId: req.sessionId,
        accepted: true,
        width: handle.width,
        height: handle.height,
        fps: req.fps ?? 12,
        mode: "p2p",
        mimeType: "image/jpeg",
      });

      toast.success(`Sharing screen with ${incoming.fromName ?? "peer"}`);
      setIncoming(null);
    } catch (e) {
      const msg = formatCaptureError(e);
      toast.error(msg);
      await api?.respondScreenShare?.({
        sessionId: req.sessionId,
        accepted: false,
        reason: msg,
      });
      setIncoming(null);
      stopCapture();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(incoming)}
      onOpenChange={(open) => {
        if (!open && incoming && !busy) void decline("Dismissed");
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorUp className="size-5 text-primary" />
            Share your screen?
          </DialogTitle>
          <DialogDescription>
            <strong>{incoming?.fromName ?? "A paired device"}</strong> wants to view this
            desktop. You will pick which screen or window to share — nothing is sent until you
            allow capture in the system dialog.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border/80 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">What happens next</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>Click Allow below</li>
            <li>Choose a display or window in the system picker</li>
            <li>Frames stream only to the paired peer over your private network</li>
          </ol>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={busy} onClick={() => void decline()}>
            Deny
          </Button>
          <Button disabled={busy} onClick={() => void accept()}>
            {busy ? "Opening picker…" : "Allow & choose screen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Compact Android wireless-debug checklist for scrcpy / ADB. */
export function AndroidMirrorSetupHints({
  hasTailscale,
  hasAdbSerial,
  hasHost,
}: {
  hasTailscale: boolean;
  hasAdbSerial: boolean;
  hasHost: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <Smartphone className="size-3.5" />
        Android mirror checklist
      </p>
      <ul className="list-disc space-y-1 pl-4">
        <li>
          Enable <strong>Developer options</strong> → <strong>Wireless debugging</strong> (or USB
          debugging)
        </li>
        <li>
          Pair wireless debugging, then{" "}
          <code className="rounded bg-muted px-1">adb connect HOST:PORT</code> (port is not always
          5555 on modern Android)
        </li>
        <li>
          Install <code className="rounded bg-muted px-1">scrcpy</code> on this desktop and keep{" "}
          <code className="rounded bg-muted px-1">adb</code> on PATH
        </li>
        <li>
          Over Tailscale: set the phone&apos;s 100.x IP below, then connect ADB to that IP
        </li>
      </ul>
      <div className="flex flex-wrap gap-2 pt-1">
        <StatusChip ok={hasHost || hasTailscale} label="Device address" />
        <StatusChip ok={hasTailscale} label="Tailscale IP" />
        <StatusChip ok={hasAdbSerial} label="ADB serial set" />
      </div>
    </div>
  );
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={
        ok
          ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
          : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
      }
    >
      {ok ? "✓" : "·"} {label}
    </span>
  );
}
