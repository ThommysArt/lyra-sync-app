import { formatFingerprint } from "@lyra-sync-app/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lyra-sync-app/ui/components/card";
import { Input } from "@lyra-sync-app/ui/components/input";
import { Label } from "@lyra-sync-app/ui/components/label";
import { Separator } from "@lyra-sync-app/ui/components/separator";
import { Switch } from "@lyra-sync-app/ui/components/switch";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const store = useLyraStore();
  const identity = useLyraSelector((s) => s.identity);
  const settings = useLyraSelector((s) => s.settings);
  const devices = useLyraSelector((s) => s.devices);
  const [name, setName] = useState(identity?.name ?? "");

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Device identity, defaults, and paired device management.
        </p>
      </div>

      <Card className="rounded-4xl">
        <CardHeader>
          <CardTitle>This device</CardTitle>
          <CardDescription>Name and cryptographic fingerprint stay on this machine.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="device-name">Device name</Label>
            <div className="flex gap-2">
              <Input
                id="device-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded-full"
              />
              <Button
                onClick={() => {
                  store.setDeviceName(name);
                }}
              >
                Save
              </Button>
            </div>
          </div>
          <div className="rounded-3xl bg-muted/60 px-4 py-3 text-sm">
            <p className="text-xs text-muted-foreground">Fingerprint</p>
            <p className="font-mono text-sm">
              {identity ? formatFingerprint(identity.fingerprint) : "—"}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Platform {identity?.platform} · ID {identity?.id}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-4xl">
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
          <CardDescription>Applied to newly paired devices and global behavior.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingRow
            label="Clipboard sync"
            description="Automatically share copies with paired devices when enabled."
            checked={settings.clipboardSyncEnabled}
            onCheckedChange={(v) => store.updateSettings({ clipboardSyncEnabled: v })}
          />
          <Separator />
          <SettingRow
            label="Auto-accept transfers"
            description="Receive files from paired devices without a prompt."
            checked={settings.autoAcceptTransfers}
            onCheckedChange={(v) => store.updateSettings({ autoAcceptTransfers: v })}
          />
          <Separator />
          <SettingRow
            label="Auto-accept clipboard"
            description="Write incoming clipboard items to the system clipboard."
            checked={settings.autoAcceptClipboard}
            onCheckedChange={(v) => store.updateSettings({ autoAcceptClipboard: v })}
          />
          <Separator />
          <SettingRow
            label="Network discovery"
            description="Announce and look for devices on the local network."
            checked={settings.discoveryEnabled}
            onCheckedChange={(v) => store.updateSettings({ discoveryEnabled: v })}
          />
          <Separator />
          <SettingRow
            label="Tailscale support"
            description="Also probe known peers over Tailscale / MagicDNS."
            checked={settings.tailscaleEnabled}
            onCheckedChange={(v) => store.updateSettings({ tailscaleEnabled: v })}
          />
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Clipboard history limit</p>
              <p className="text-xs text-muted-foreground">Number of recent items to keep locally.</p>
            </div>
            <Input
              type="number"
              min={5}
              max={200}
              className="w-24 rounded-full"
              value={settings.clipboardHistoryLimit}
              onChange={(e) =>
                store.updateSettings({
                  clipboardHistoryLimit: Math.min(200, Math.max(5, Number(e.target.value) || 40)),
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-4xl">
        <CardHeader>
          <CardTitle>Paired devices</CardTitle>
          <CardDescription>
            {devices.length} device{devices.length === 1 ? "" : "s"} in your trusted network.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {devices.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between gap-3 rounded-3xl border border-border/70 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{d.nickname || d.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {d.online ? "Online" : "Offline"} · {d.platform}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Link
                  to="/devices/$deviceId"
                  params={{ deviceId: d.id }}
                  className="inline-flex h-8 items-center justify-center rounded-full border border-border px-3 text-sm font-medium hover:bg-muted"
                >
                  Manage
                </Link>
                <Button size="sm" variant="ghost" onClick={() => store.unpairDevice(d.id)}>
                  Unpair
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function SettingRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
