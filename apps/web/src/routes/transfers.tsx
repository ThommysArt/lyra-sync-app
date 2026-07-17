import {
  formatBytes,
  formatPercent,
  formatRelativeTime,
  formatSpeed,
} from "@lyra-sync-app/core";
import { createFileRoute } from "@tanstack/react-router";
import { Pause, Play, X } from "lucide-react";

import { Badge } from "@lyra-sync-app/ui/components/badge";
import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent } from "@lyra-sync-app/ui/components/card";
import { Progress } from "@lyra-sync-app/ui/components/progress";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export const Route = createFileRoute("/transfers")({
  component: TransfersPage,
});

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed" || status === "cancelled") return "destructive";
  if (status === "transferring") return "secondary";
  return "outline";
}

function TransfersPage() {
  const store = useLyraStore();
  const transfers = useLyraSelector((s) =>
    [...s.transfers].sort((a, b) => b.createdAt - a.createdAt),
  );
  const onlineIds = useLyraSelector((s) => s.devices.filter((d) => d.online).map((d) => d.id));

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Transfers</h1>
          <p className="text-sm text-muted-foreground">
            Active sessions and history. Pause, resume, or cancel anytime.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              if (onlineIds.length === 0) return;
              store.startFileTransfer(onlineIds.slice(0, 2), [
                { name: "photos-export.zip", size: 64_000_000, mimeType: "application/zip" },
              ]);
            }}
          >
            Demo send
          </Button>
          <Button size="sm" variant="outline" onClick={() => store.clearTransferHistory()}>
            Clear history
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {transfers.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No transfers yet.</p>
        ) : (
          transfers.map((tx) => {
            const pct = formatPercent(tx.transferredBytes, tx.totalBytes);
            const names = tx.files.map((f) => f.name).join(", ");
            return (
              <Card key={tx.id} className="rounded-3xl">
                <CardContent className="space-y-3 p-4">
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

                  {(tx.status === "transferring" || tx.status === "paused" || tx.status === "pending") && (
                    <div className="space-y-1.5">
                      <Progress value={pct} className="h-2" />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {formatBytes(tx.transferredBytes)} / {formatBytes(tx.totalBytes)} ({pct}%)
                        </span>
                        <span>{formatSpeed(tx.averageSpeedBps)}</span>
                      </div>
                    </div>
                  )}

                  {tx.status === "completed" && (
                    <p className="text-xs text-muted-foreground">
                      Done in {tx.durationMs ? `${Math.round(tx.durationMs / 1000)}s` : "—"} · avg{" "}
                      {formatSpeed(tx.averageSpeedBps)}
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
                        onClick={() => store.setTransferStatus(tx.id, "transferring")}
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
                    {tx.direction === "sent" && tx.status === "completed" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          store.startFileTransfer(
                            [tx.deviceId],
                            tx.files.map((f) => ({
                              name: f.name,
                              size: f.size,
                              mimeType: f.mimeType,
                            })),
                          )
                        }
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
