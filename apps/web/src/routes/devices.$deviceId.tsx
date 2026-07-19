import {
  connectionLabel,
  formatBytes,
  formatFingerprint,
  formatRelativeTime,
  platformLabel,
} from "@lyra-sync-app/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File,
  Folder,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@lyra-sync-app/ui/components/badge";
import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lyra-sync-app/ui/components/card";
import { Input } from "@lyra-sync-app/ui/components/input";
import { Label } from "@lyra-sync-app/ui/components/label";
import { Separator } from "@lyra-sync-app/ui/components/separator";
import { Switch } from "@lyra-sync-app/ui/components/switch";
import { DropZone } from "@/components/drop-zone";
import { readSystemClipboard } from "@/lib/clipboard";
import { pickFiles } from "@/lib/file-picker";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export const Route = createFileRoute("/devices/$deviceId")({
  component: DeviceDetailPage,
});

function DeviceDetailPage() {
  const { deviceId } = Route.useParams();
  const store = useLyraStore();
  const device = useLyraSelector((s) => s.devices.find((d) => d.id === deviceId));
  const [nickname, setNickname] = useState(device?.nickname ?? "");
  const [path, setPath] = useState("/");
  const [selected, setSelected] = useState<string[]>([]);

  const cacheKey = `${deviceId}::${path}`;
  const entries = useLyraSelector((s) => s.remoteFsCache[cacheKey] ?? []);

  useEffect(() => {
    void store.fetchRemoteFiles(deviceId, path);
  }, [deviceId, path, store]);

  if (!device) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">Device not found.</p>
        <Link to="/" className="mt-2 inline-flex text-sm text-primary">
          Back to devices
        </Link>
      </div>
    );
  }

  const displayName = device.nickname || device.name;
  const parentPath =
    path === "/" ? null : path.split("/").slice(0, -1).join("/") || "/";

  const uploadLocal = async () => {
    const files = await pickFiles({ multiple: true });
    if (files.length === 0) return;
    store.startFileTransfer(
      [device.id],
      files.map((f) => ({ name: f.name, size: f.size, mimeType: f.mimeType })),
    );
  };

  const downloadSelected = () => {
    const files = entries
      .filter((e) => selected.includes(e.path) && !e.isDirectory)
      .map((e) => ({
        name: e.name,
        size: e.size ?? 1024,
        mimeType: e.mimeType,
      }));
    if (files.length === 0) return;
    // Demo: first file triggers conflict UI when named report.pdf or always for multi-select first
    const forceConflict = files.some((f) => f.name === "report.pdf" || f.name.endsWith(".pdf"));
    store.startFileTransfer([device.id], files, {
      direction: "received",
      forceConflict,
    });
    setSelected([]);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-8">
      <div className="flex items-center gap-3">
        <Link
          to="/"
          className="inline-flex size-8 items-center justify-center rounded-full hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{displayName}</h1>
            <span
              className={`size-2 rounded-full ${device.online ? "bg-success" : "bg-muted-foreground/40"}`}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {platformLabel(device.platform)} · {connectionLabel(device.connectionType)} · Seen{" "}
            {formatRelativeTime(device.lastSeenAt)}
          </p>
        </div>
        <Badge variant={device.online ? "default" : "secondary"}>
          {device.online ? "Online" : "Offline"}
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="rounded-4xl lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Device settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Local nickname</Label>
              <div className="flex gap-2">
                <Input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder={device.name}
                  className="rounded-full"
                />
                <Button size="sm" onClick={() => store.renameDevice(device.id, nickname)}>
                  Save
                </Button>
              </div>
            </div>
            <div className="rounded-3xl bg-muted/50 px-3 py-2 text-xs">
              <p className="text-muted-foreground">Fingerprint</p>
              <p className="font-mono">{formatFingerprint(device.fingerprint)}</p>
            </div>
            <Separator />
            <ToggleRow
              label="Auto-accept transfers"
              checked={device.autoAcceptTransfers}
              onChange={(v) => store.updateDeviceSettings(device.id, { autoAcceptTransfers: v })}
            />
            <ToggleRow
              label="Auto-accept clipboard"
              checked={device.autoAcceptClipboard}
              onChange={(v) => store.updateDeviceSettings(device.id, { autoAcceptClipboard: v })}
            />
            <ToggleRow
              label="Show in main list"
              checked={device.showInMainList}
              onChange={(v) => store.updateDeviceSettings(device.id, { showInMainList: v })}
            />
            <Separator />
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                disabled={!device.online}
                onClick={() => {
                  void readSystemClipboard().then((text) => {
                    store.pushClipboardText(text || "Quick share from device detail", [device.id]);
                  });
                }}
              >
                Send clipboard
              </Button>
              <Button variant="outline" disabled={!device.online} onClick={() => void uploadLocal()}>
                <Upload className="size-4" />
                Upload files
              </Button>
              <Button variant="destructive" onClick={() => store.unpairDevice(device.id)}>
                Unpair device
              </Button>
            </div>
          </CardContent>
        </Card>

        <DropZone
          className="rounded-4xl lg:col-span-3"
          disabled={!device.online}
          label={`Upload to ${path}`}
          onDropFiles={(files) => {
            store.startFileTransfer(
              [device.id],
              files.map((f) => ({ name: f.name, size: f.size, mimeType: f.mimeType })),
            );
          }}
        >
          <Card className="h-full rounded-4xl">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Remote files</CardTitle>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!device.online}
                  onClick={() => void uploadLocal()}
                >
                  <Upload className="size-4" />
                  Upload
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selected.length === 0 || !device.online}
                  onClick={downloadSelected}
                >
                  <Download className="size-4" />
                  Download
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {parentPath !== null && (
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => {
                      setPath(parentPath);
                      setSelected([]);
                    }}
                  >
                    Up
                  </button>
                )}
                <span className="truncate font-mono">{path}</span>
              </div>

              {!device.online ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Device offline — browse when it comes back.
                </p>
              ) : (
                <div className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/70">
                  {entries.map((entry) => {
                    const isSelected = selected.includes(entry.path);
                    return (
                      <div
                        key={entry.path}
                        className="flex items-center gap-2 px-3 py-2.5 hover:bg-muted/40"
                      >
                        <input
                          type="checkbox"
                          className="size-4 rounded"
                          checked={isSelected}
                          onChange={() => {
                            setSelected((prev) =>
                              isSelected
                                ? prev.filter((p) => p !== entry.path)
                                : [...prev, entry.path],
                            );
                          }}
                        />
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => {
                            if (entry.isDirectory) {
                              setPath(entry.path);
                              setSelected([]);
                            }
                          }}
                        >
                          {entry.isDirectory ? (
                            <Folder className="size-4 shrink-0 text-primary" />
                          ) : (
                            <File className="size-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate text-sm">{entry.name}</span>
                          {entry.isDirectory ? (
                            <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                              {entry.size != null ? formatBytes(entry.size) : ""}
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Smart folders appear at the root. Drop files here to upload. Downloading a PDF may
                prompt conflict resolution.
              </p>
            </CardContent>
          </Card>
        </DropZone>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
