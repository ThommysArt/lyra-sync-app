import { createFileRoute } from "@tanstack/react-router";
import { Link2, Plus, Radar, Send, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Badge } from "@lyra-sync-app/ui/components/badge";
import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent } from "@lyra-sync-app/ui/components/card";
import { Input } from "@lyra-sync-app/ui/components/input";
import { Label } from "@lyra-sync-app/ui/components/label";
import { DeviceCard } from "@/components/device-card";
import { PairingDialog } from "@/components/pairing-dialog";
import { readSystemClipboard } from "@/lib/clipboard";
import { materializeFileBytes, pickFiles, type PickedFile } from "@/lib/file-picker";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export const Route = createFileRoute("/")({
  component: DevicesPage,
});

async function prepareFilesForWire(files: PickedFile[]) {
  return Promise.all(
    files.map(async (f) => {
      const bytes = f.bytes ?? (f.file ? await materializeFileBytes(f.file) : undefined);
      return {
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
        relativePath: f.relativePath,
        bytes,
      };
    }),
  );
}

function DevicesPage() {
  const store = useLyraStore();
  // Trusted network only (paired with authSecret, or demo seeds shown in main list)
  const devices = useLyraSelector((s) =>
    s.devices
      .filter((d) => d.authSecret || (d.showInMainList && d.id.startsWith("demo_")))
      .sort((a, b) => Number(b.online) - Number(a.online)),
  );
  const nearby = useLyraSelector((s) =>
    s.devices
      .filter((d) => !d.authSecret && !d.id.startsWith("demo_") && Boolean(d.host))
      .sort((a, b) => Number(b.online) - Number(a.online)),
  );
  const localClipboard = useLyraSelector((s) => s.localClipboardText);
  const discoveryEnabled = useLyraSelector((s) => s.settings.discoveryEnabled);
  const [query, setQuery] = useState("");
  const [pairOpen, setPairOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("53317");
  const [manualName, setManualName] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [trustBusy, setTrustBusy] = useState<string | null>(null);

  const filtered = devices.filter((d) => {
    const name = (d.nickname || d.name).toLowerCase();
    const host = (d.host ?? "").toLowerCase();
    const q = query.toLowerCase();
    return name.includes(q) || host.includes(q);
  });

  const onlineIds = devices.filter((d) => d.online).map((d) => d.id);
  const sendClipboard = async (targetIds: string[]) => {
    const system = await readSystemClipboard();
    const text = system || localClipboard || "Hello from Lyra";
    store.setLocalClipboardText(text);
    store.pushClipboardText(text, targetIds);
  };

  const sendFilesTo = async (deviceId: string) => {
    const files = await pickFiles({ multiple: true });
    if (files.length === 0) return;
    const prepared = await prepareFilesForWire(files);
    store.startFileTransfer([deviceId], prepared);
  };

  const addManual = () => {
    const host = manualHost.trim();
    const port = Number(manualPort) || 53317;
    const result = store.addManualPeer({
      host,
      port,
      name: manualName || undefined,
    });
    if (!result.ok) {
      setManualError(result.error);
      return;
    }
    setManualError(null);
    setManualHost("");
    setManualName("");
    setManualPort("53317");
    // Live HTTP probe when a peer server is reachable
    void store.probePeerAddress({ host, port });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Devices</h1>
          <p className="text-sm text-muted-foreground">
            Your trusted local network — no accounts, no cloud. Drag files onto a device to send.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => store.refreshDiscovery()}
            disabled={!discoveryEnabled}
            title={
              discoveryEnabled
                ? "Refresh LAN / known peer discovery"
                : "Enable network discovery in Settings"
            }
          >
            <Radar className="size-4" />
            Refresh discovery
          </Button>
          <Button variant="outline" onClick={() => setPairOpen(true)}>
            <Link2 className="size-4" />
            Pair device
          </Button>
          <Button onClick={() => void sendClipboard(onlineIds)}>
            <Send className="size-4" />
            Send clipboard
          </Button>
        </div>
      </div>

      <Card className="rounded-4xl">
        <CardContent className="space-y-3 p-4">
          <div>
            <p className="text-sm font-medium">Find device by address</p>
            <p className="text-xs text-muted-foreground">
              Adds a <strong>nearby</strong> peer (not trusted yet). Use Pair to establish trust.
              Default port 53317.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_7rem_1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="manual-host" className="text-xs">
                Host / IP
              </Label>
              <Input
                id="manual-host"
                value={manualHost}
                onChange={(e) => setManualHost(e.target.value)}
                placeholder="192.168.1.42 or laptop.tailnet"
                className="rounded-full"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-port" className="text-xs">
                Port
              </Label>
              <Input
                id="manual-port"
                value={manualPort}
                onChange={(e) => setManualPort(e.target.value)}
                className="rounded-full"
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-name" className="text-xs">
                Nickname (optional)
              </Label>
              <Input
                id="manual-name"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="Office laptop"
                className="rounded-full"
              />
            </div>
            <div className="flex items-end">
              <Button disabled={!manualHost.trim()} onClick={addManual} className="w-full sm:w-auto">
                <Plus className="size-4" />
                Add peer
              </Button>
            </div>
          </div>
          {manualError ? <p className="text-xs text-destructive">{manualError}</p> : null}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search devices…"
          className="rounded-full sm:max-w-xs"
        />
        <div className="flex min-w-0 flex-1 gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Open URL on other devices…"
            className="rounded-full"
          />
          <Button
            variant="secondary"
            disabled={!url.trim() || onlineIds.length === 0}
            onClick={() => {
              store.sendUrl(url.trim(), onlineIds);
              setUrl("");
            }}
          >
            Open
          </Button>
        </div>
      </div>

      {nearby.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold tracking-tight">Nearby (not paired)</h2>
            <Badge variant="outline" className="rounded-full">
              {nearby.length}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Discovered on the LAN or added by address. Pairing is separate — accept once on each
            device to trust.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {nearby.map((device) => (
              <Card key={device.id} className="rounded-3xl border-dashed border-border/80">
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{device.nickname || device.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {device.host}
                      {device.port ? `:${device.port}` : ""} · {device.online ? "online" : "offline"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      disabled={!device.host || trustBusy === device.id}
                      onClick={() => {
                        setTrustBusy(device.id);
                        void store.trustDevice(device.id).finally(() => setTrustBusy(null));
                      }}
                    >
                      <ShieldCheck className="size-3.5" />
                      Pair
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => store.unpairDevice(device.id)}>
                      Dismiss
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-4xl border border-dashed border-border px-6 py-16 text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Plus className="size-5" />
          </div>
          <h2 className="font-medium">No paired devices yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Pair a phone or computer to sync clipboard and transfer files privately on your network.
            Nearby discovery alone does not create trust.
          </p>
          <Button className="mt-4" onClick={() => setPairOpen(true)}>
            Pair your first device
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filtered.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              onSendClipboard={() => void sendClipboard([device.id])}
              onSendFiles={() => void sendFilesTo(device.id)}
              onDropFiles={(files) => {
                if (!device.online || files.length === 0) return;
                void prepareFilesForWire(files).then((prepared) => {
                  store.startFileTransfer([device.id], prepared);
                });
              }}
            />
          ))}
        </div>
      )}

      <PairingDialog open={pairOpen} onOpenChange={setPairOpen} />
    </div>
  );
}
