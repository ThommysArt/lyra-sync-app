import type { PairedDevice } from "@lyra-sync-app/protocol";
import {
  connectionLabel,
  formatBytes,
  formatRelativeTime,
  platformLabel,
} from "@lyra-sync-app/core";
import { Battery, BatteryCharging, Laptop, Monitor, Smartphone, Wifi } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Badge } from "@lyra-sync-app/ui/components/badge";
import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent } from "@lyra-sync-app/ui/components/card";
import { cn } from "@/lib/utils";
import { DropZone } from "@/components/drop-zone";
import type { PickedFile } from "@/lib/file-picker";

function DeviceGlyph({ device }: { device: PairedDevice }) {
  const Icon =
    device.type === "mobile" ? Smartphone : device.platform === "macos" ? Laptop : Monitor;
  return (
    <div
      className={cn(
        "flex size-11 items-center justify-center rounded-2xl",
        device.online ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      <Icon className="size-5" />
    </div>
  );
}

export function DeviceCard({
  device,
  onSendClipboard,
  onSendFiles,
  onDropFiles,
}: {
  device: PairedDevice;
  onSendClipboard?: () => void;
  onSendFiles?: () => void;
  onDropFiles?: (files: PickedFile[]) => void;
}) {
  const displayName = device.nickname || device.name;
  const battery = device.status?.batteryLevel;
  const charging = device.status?.isCharging;

  const card = (
    <Card className="overflow-hidden rounded-3xl border-border/70 shadow-sm transition-shadow hover:shadow-md">
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <DeviceGlyph device={device} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-semibold tracking-tight">{displayName}</h3>
              <span
                className={cn(
                  "inline-flex size-2 shrink-0 rounded-full",
                  device.online ? "bg-success" : "bg-muted-foreground/40",
                )}
                title={device.online ? "Online" : "Offline"}
              />
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {platformLabel(device.platform)}
              {device.model ? ` · ${device.model}` : ""}
              {device.host ? ` · ${device.host}${device.port ? `:${device.port}` : ""}` : ""}
            </p>
          </div>
          <Badge variant="secondary" className="rounded-full shrink-0">
            {connectionLabel(device.connectionType)}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Wifi className="size-3.5" />
            {device.host
              ? `${device.host}${device.port ? `:${device.port}` : ""}`
              : (device.status?.networkName ?? (device.online ? "Connected" : "Offline"))}
          </span>
          {battery != null && (
            <span className="inline-flex items-center gap-1">
              {charging ? (
                <BatteryCharging className="size-3.5 text-success" />
              ) : (
                <Battery className="size-3.5" />
              )}
              {battery}%
            </span>
          )}
          {device.status?.freeStorageBytes != null && (
            <span>{formatBytes(device.status.freeStorageBytes)} free</span>
          )}
          <span>Seen {formatRelativeTime(device.lastSeenAt)}</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!device.online} onClick={onSendClipboard}>
            Send clipboard
          </Button>
          <Button size="sm" variant="outline" disabled={!device.online} onClick={onSendFiles}>
            Send files
          </Button>
          <Link
            to="/devices/$deviceId"
            params={{ deviceId: device.id }}
            className="ml-auto inline-flex h-8 items-center justify-center rounded-full bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            Open
          </Link>
        </div>
      </CardContent>
    </Card>
  );

  if (!onDropFiles) return card;

  return (
    <DropZone
      className="rounded-3xl"
      disabled={!device.online}
      label={`Send to ${displayName}`}
      onDropFiles={onDropFiles}
    >
      {card}
    </DropZone>
  );
}
