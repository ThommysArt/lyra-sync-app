import {
  formatBytes,
  formatEta,
  formatPercent,
  formatRelativeTime,
  formatSpeed,
} from "@lyra-sync-app/core";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Pause, Play, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@lyra-sync-app/ui/components/badge";
import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent } from "@lyra-sync-app/ui/components/card";
import { Input } from "@lyra-sync-app/ui/components/input";
import { Progress } from "@lyra-sync-app/ui/components/progress";
import { FilePreview } from "@/components/file-preview";
import { materializeFileBytes, pickFiles } from "@/lib/file-picker";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export const Route = createFileRoute("/transfers")({
  component: TransfersPage,
});

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed" || status === "cancelled") return "destructive";
  if (status === "transferring") return "secondary";
  if (status === "conflict") return "outline";
  return "outline";
}

function TransfersPage() {
  const store = useLyraStore();
  const transfers = useLyraSelector((s) =>
    [...s.transfers].sort((a, b) => b.createdAt - a.createdAt),
  );
  const onlineIds = useLyraSelector((s) => s.devices.filter((d) => d.online).map((d) => d.id));
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return transfers;
    return transfers.filter((tx) => {
      const names = tx.files.map((f) => f.name).join(" ").toLowerCase();
      return (
        names.includes(q) ||
        tx.deviceName.toLowerCase().includes(q) ||
        tx.status.toLowerCase().includes(q) ||
        tx.direction.toLowerCase().includes(q)
      );
    });
  }, [filter, transfers]);

  const pickAndSend = async () => {
    if (onlineIds.length === 0) return;
    const files = await pickFiles({ multiple: true });
    if (files.length === 0) return;
    // Materialize up to 256 MiB (streamed read); larger stays synthetic/demo
    const prepared = await Promise.all(
      files.map(async (f) => {
        const bytes =
          f.bytes ?? (f.file ? await materializeFileBytes(f.file) : undefined);
        return {
          name: f.name,
          size: f.size,
          mimeType: f.mimeType,
          relativePath: f.relativePath,
          bytes,
        };
      }),
    );
    store.startFileTransfer(onlineIds.slice(0, 2), prepared);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:px-5 md:py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Transfers</h1>
          <p className="text-sm text-muted-foreground">
            Active sessions and history. Pause, resume, or cancel anytime.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void pickAndSend()}>
            <Upload className="size-4" />
            Send files
          </Button>
          <Button size="sm" variant="outline" onClick={() => store.clearTransferHistory()}>
            Clear history
          </Button>
          {/* Opt-in dummy conflict helpers — only when VITE_LYRA_SEED_DEMO=1 */}
          {import.meta.env.VITE_LYRA_SEED_DEMO === "1" ||
          import.meta.env.VITE_LYRA_SEED_DEMO === "true" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => store.simulateIncomingConflict({ multiFile: true })}
              >
                <AlertTriangle className="size-4" />
                Demo multi-file
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => store.simulateIncomingConflict({ batch: true })}
              >
                <AlertTriangle className="size-4" />
                Demo batch
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (onlineIds.length === 0) {
                    // No device — still allow local resume demo via forceSimulate
                    store.startFileTransfer(
                      ["local_demo"],
                      [
                        { name: "movie.mp4", size: 80_000_000, mimeType: "video/mp4" },
                        { name: "sidecar.json", size: 4_000, mimeType: "application/json" },
                      ],
                      {
                        initialOffset: 32_000_000,
                        verifyIntegrity: true,
                        forceSimulate: true,
                      },
                    );
                    return;
                  }
                  store.startFileTransfer(
                    [onlineIds[0]!],
                    [
                      { name: "movie.mp4", size: 80_000_000, mimeType: "video/mp4" },
                      { name: "sidecar.json", size: 4_000, mimeType: "application/json" },
                    ],
                    {
                      initialOffset: 32_000_000,
                      verifyIntegrity: true,
                      forceSimulate: true,
                    },
                  );
                }}
              >
                Demo resume
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search transfers by name, device, or status…"
        className="rounded-md"
        aria-label="Search transfer history"
      />

      <div className="space-y-3">
        {filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {transfers.length === 0 ? "No transfers yet." : "No transfers match your search."}
          </p>
        ) : (
          filtered.map((tx) => {
            const pct = formatPercent(tx.transferredBytes, tx.totalBytes);
            const names = tx.files.map((f) => f.name).join(", ");
            return (
              <Card key={tx.id} className="rounded-xl">
                <CardContent className="space-y-3 p-3">
                  <div className="flex items-start gap-3">
                    <FilePreview
                      files={tx.files.map((f) => ({
                        name: f.name,
                        mimeType: f.mimeType,
                      }))}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{names}</p>
                          <p className="text-xs text-muted-foreground">
                            {tx.direction === "sent" ? "To" : "From"} {tx.deviceName} ·{" "}
                            {formatBytes(tx.totalBytes)} · {formatRelativeTime(tx.createdAt)}
                          </p>
                        </div>
                        <Badge variant={statusVariant(tx.status)} className="capitalize">
                          {tx.status}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  {tx.status === "conflict" && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                      <p className="text-sm font-medium">
                        {(tx.conflictFileNames?.length ?? 0) > 1
                          ? `${tx.conflictFileNames!.length} files already exist`
                          : `“${tx.conflictFileName ?? names}” already exists`}
                      </p>
                      {(tx.conflictFileNames?.length ?? 0) > 1 && (
                        <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                          {tx.conflictFileNames!.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => store.resolveTransferConflict(tx.id, "skip")}
                        >
                          Skip
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => store.resolveTransferConflict(tx.id, "rename")}
                        >
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => store.resolveTransferConflict(tx.id, "overwrite")}
                        >
                          Overwrite
                        </Button>
                      </div>
                    </div>
                  )}

                  {(tx.status === "transferring" ||
                    tx.status === "paused" ||
                    tx.status === "pending") && (
                    <div className="space-y-1.5">
                      <Progress value={pct} className="h-2" />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {formatBytes(tx.transferredBytes)} / {formatBytes(tx.totalBytes)} ({pct}%)
                          {tx.overWire ? " · wire" : ""}
                        </span>
                        <span>
                          {formatSpeed(tx.currentSpeedBps ?? tx.averageSpeedBps)}
                          {tx.status === "transferring" && tx.etaSeconds != null
                            ? ` · ETA ${formatEta(tx.etaSeconds)}`
                            : ""}
                        </span>
                      </div>
                    </div>
                  )}

                  {tx.status === "completed" && (
                    <p className="text-xs text-muted-foreground">
                      Done in {tx.durationMs ? `${Math.round(tx.durationMs / 1000)}s` : "—"} · avg{" "}
                      {formatSpeed(tx.averageSpeedBps)}
                      {tx.conflictResolved ? ` · resolved via ${tx.conflictResolved}` : ""}
                      {tx.integrityOk === true
                        ? " · integrity verified"
                        : tx.integrityOk === false
                          ? " · integrity failed"
                          : ""}
                    </p>
                  )}

                  {tx.status === "paused" && (tx.resumeOffset ?? tx.transferredBytes) > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Resumable from {formatBytes(tx.resumeOffset ?? tx.transferredBytes)} (
                      {formatPercent(tx.transferredBytes, tx.totalBytes)}%)
                    </p>
                  )}

                  <div className="flex gap-1">
                    {tx.status === "transferring" && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => store.setTransferStatus(tx.id, "paused")}
                      >
                        <Pause className="size-4" />
                      </Button>
                    )}
                    {tx.status === "paused" && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => store.resumeTransfer(tx.id)}
                        aria-label="Resume transfer"
                      >
                        <Play className="size-4" />
                      </Button>
                    )}
                    {(tx.status === "transferring" ||
                      tx.status === "paused" ||
                      tx.status === "pending") && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => store.setTransferStatus(tx.id, "cancelled")}
                      >
                        <X className="size-4" />
                      </Button>
                    )}
                    {(tx.status === "completed" || tx.status === "cancelled") && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => store.resendTransfer(tx.id)}
                      >
                        Re-send
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
