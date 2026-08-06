import { formatFingerprint } from "@lyra-sync-app/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@lyra-sync-app/ui/components/badge";
import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lyra-sync-app/ui/components/card";
import { Input } from "@lyra-sync-app/ui/components/input";
import { Label } from "@lyra-sync-app/ui/components/label";
import { Separator } from "@lyra-sync-app/ui/components/separator";
import { Switch } from "@lyra-sync-app/ui/components/switch";
import { getDesktopApi, isDesktopShell } from "@/lib/desktop-bridge";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const store = useLyraStore();
  const identity = useLyraSelector((s) => s.identity);
  const settings = useLyraSelector((s) => s.settings);
  const devices = useLyraSelector((s) => s.devices.filter((d) => d.authSecret || d.id.startsWith("demo_")));
  const peerServer = useLyraSelector((s) => s.peerServer);
  const lastProbeSummary = useLyraSelector((s) => s.lastProbeSummary);
  const [name, setName] = useState(identity?.name ?? "");
  const [probeBusy, setProbeBusy] = useState(false);
  const [downloadPath, setDownloadPath] = useState(settings.downloadDirectory ?? "");
  const desktop = isDesktopShell();

  useEffect(() => {
    if (!desktop) return;
    const api = getDesktopApi();
    if (!api?.getDownloadDirectory) return;
    void api.getDownloadDirectory().then((path) => {
      if (!settings.downloadDirectory) setDownloadPath(path);
      else setDownloadPath(settings.downloadDirectory);
    });
  }, [desktop, settings.downloadDirectory]);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 md:px-5 md:py-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Device identity, defaults, and paired device management.
        </p>
      </div>

      <Card className="rounded-xl">
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
                className="rounded-md"
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
          <div className="rounded-xl bg-muted/60 px-4 py-3 text-sm">
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

      <Card className="rounded-xl">
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
            label="Auto-monitor system clipboard"
            description="While Lyra is open and focused, detect new copies on this desktop and capture them (browser may ask for clipboard permission)."
            checked={settings.autoMonitorClipboard}
            onCheckedChange={(v) => store.updateSettings({ autoMonitorClipboard: v })}
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
            description="Also probe known peers over Tailscale / MagicDNS. Enables Add by Tailscale IP on Devices."
            checked={settings.tailscaleEnabled}
            onCheckedChange={(v) => store.updateSettings({ tailscaleEnabled: v })}
          />
          <Separator />
          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium">Scrcpy path (Android mirror)</p>
              <p className="text-xs text-muted-foreground">
                Optional path to the scrcpy binary (Sefirah-style). Empty = use PATH.
              </p>
            </div>
            <Input
              value={settings.scrcpyPath ?? ""}
              onChange={(e) =>
                store.updateSettings({ scrcpyPath: e.target.value.trim() || undefined })
              }
              placeholder="/usr/bin/scrcpy or leave empty"
              className="rounded-md font-mono text-xs"
            />
          </div>
          <Separator />
          <SettingRow
            label="Verify transfer integrity"
            description="Check SHA-256 after transfers complete when checksums are available."
            checked={settings.verifyTransferIntegrity}
            onCheckedChange={(v) => store.updateSettings({ verifyTransferIntegrity: v })}
          />
          <Separator />
          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium">Download location</p>
              <p className="text-xs text-muted-foreground">
                {desktop
                  ? "Where received files are saved. Opens the system folder dialog."
                  : "In the browser, received files download via the browser download UI. Use the desktop or mobile app to pick a permanent folder."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                readOnly
                value={
                  downloadPath ||
                  (desktop ? "System Downloads (default)" : "Browser downloads (default)")
                }
                className="min-w-0 flex-1 rounded-md font-mono text-xs"
              />
              {desktop ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const api = getDesktopApi();
                      void api?.chooseDownloadDirectory?.().then((res) => {
                        if (res.ok) {
                          setDownloadPath(res.path);
                          store.updateSettings({ downloadDirectory: res.path });
                        }
                      });
                    }}
                  >
                    <FolderOpen className="size-4" />
                    Browse
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDownloadPath("");
                      store.updateSettings({ downloadDirectory: undefined });
                      void getDesktopApi()?.setDownloadDirectory?.(null).then((res) => {
                        if (res.ok) setDownloadPath(res.path);
                      });
                    }}
                  >
                    Reset
                  </Button>
                </>
              ) : null}
            </div>
          </div>
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
              className="w-24 rounded-md"
              value={settings.clipboardHistoryLimit}
              onChange={(e) =>
                store.updateSettings({
                  clipboardHistoryLimit: Math.min(200, Math.max(5, Number(e.target.value) || 40)),
                })
              }
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Peer listen port</p>
              <p className="text-xs text-muted-foreground">
                HTTP port used by the desktop peer server (default 53317).
              </p>
            </div>
            <Input
              type="number"
              min={1024}
              max={65535}
              className="w-28 rounded-md"
              value={settings.peerListenPort}
              onChange={(e) =>
                store.updateSettings({
                  peerListenPort: Math.min(65535, Math.max(1024, Number(e.target.value) || 53317)),
                })
              }
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Clipboard retention (days)</p>
              <p className="text-xs text-muted-foreground">
                0 = keep by count limit only. Pinned items are never auto-removed.
              </p>
            </div>
            <Input
              type="number"
              min={0}
              max={365}
              className="w-24 rounded-md"
              value={settings.clipboardRetentionDays}
              onChange={(e) =>
                store.updateSettings({
                  clipboardRetentionDays: Math.min(
                    365,
                    Math.max(0, Number(e.target.value) || 0),
                  ),
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle>Network</CardTitle>
          <CardDescription>
            Local peer server, UDP multicast + HTTP subnet scan (LocalSend-style), and Tailscale.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={peerServer.running ? "default" : "secondary"}>
              {peerServer.running ? "Peer server running" : "Peer server idle"}
            </Badge>
            <Badge variant={peerServer.discoveryActive ? "default" : "outline"}>
              {peerServer.discoveryActive ? "Discovery active" : "Discovery off"}
            </Badge>
            {desktop ? (
              <Badge variant="outline">Desktop shell</Badge>
            ) : (
              <Badge variant="outline">Browser</Badge>
            )}
          </div>
          <div className="rounded-xl bg-muted/60 px-4 py-3 text-sm">
            <p className="text-xs text-muted-foreground">Listen endpoint</p>
            <p className="font-mono text-sm">
              {peerServer.url ??
                (desktop
                  ? "Starting…"
                  : `Browser mode — run desktop shell or peer-server on :${settings.peerListenPort}`)}
            </p>
            {peerServer.lastError ? (
              <p className="mt-2 text-xs text-destructive">{peerServer.lastError}</p>
            ) : null}
            {lastProbeSummary ? (
              <p className="mt-2 text-xs text-muted-foreground">{lastProbeSummary}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={probeBusy}
              onClick={() => {
                setProbeBusy(true);
                void Promise.resolve(store.refreshDiscovery()).finally(() => setProbeBusy(false));
              }}
            >
              Refresh discovery
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={probeBusy || !settings.tailscaleEnabled}
              onClick={() => {
                setProbeBusy(true);
                void (async () => {
                  try {
                    const api = getDesktopApi();
                    if (api?.scanTailscale) {
                      const res = await api.scanTailscale();
                      if (res.ok) {
                        store.ingestTailscalePeers(res.peers);
                        store.setTailscaleStatus({
                          ok: true,
                          backendState: res.backendState,
                          selfHost: res.self?.host,
                          selfIp: res.self?.tailscaleIp,
                          updatedAt: Date.now(),
                        });
                      } else {
                        store.setTailscaleStatus({
                          ok: false,
                          error: res.error,
                          updatedAt: Date.now(),
                        });
                      }
                    }
                    await store.probeTailscalePeers();
                  } finally {
                    setProbeBusy(false);
                  }
                })();
              }}
            >
              Scan & probe Tailscale
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Real sockets run in the Electron desktop shell or{" "}
            <code className="rounded bg-muted px-1">pnpm peer-server</code>. The browser UI probes
            known hosts via HTTP <code className="rounded bg-muted px-1">/lyra/info</code>.
            Add Tailscale device IPs on the Devices page (
            <code className="rounded bg-muted px-1">100.x</code> / MagicDNS).
          </p>
          <p className="text-xs text-muted-foreground">
            Post-pairing payloads use app-level AES-GCM when a shared auth secret exists. Mobile /
            browser cannot accept unsolicited LAN connections — keep a desktop peer online to
            receive.
          </p>
        </CardContent>
      </Card>

      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle>Keyboard shortcuts</CardTitle>
          <CardDescription>In-app power-user bindings (Ctrl on Windows/Linux, ⌘ on macOS).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {[
            ["Mod+K", "Focus device search"],
            ["Mod+,", "Open settings"],
            ["Mod+E", "Open first online device explorer"],
            ["Mod+Shift+V", "Send system clipboard to online devices"],
            ["Mod+Shift+C", "Open clipboard history"],
            ["Mod+Shift+T", "Open transfers"],
            ["Mod+Shift+P", "Pause / resume active transfers"],
            ["Mod+Q", "Quit (desktop shell only)"],
          ].map(([keys, desc]) => (
            <div key={keys} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{desc}</span>
              <kbd className="rounded-md bg-muted px-2.5 py-1 font-mono text-xs">{keys}</kbd>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-xl">
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
              className="flex items-center justify-between gap-3 rounded-xl border border-border/70 px-3 py-2.5"
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
                  className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
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
