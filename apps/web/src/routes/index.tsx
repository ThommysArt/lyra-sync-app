import { createFileRoute } from "@tanstack/react-router";
import { Link2, Plus, Send } from "lucide-react";
import { useState } from "react";

import { Button } from "@lyra-sync-app/ui/components/button";
import { Input } from "@lyra-sync-app/ui/components/input";
import { DeviceCard } from "@/components/device-card";
import { PairingDialog } from "@/components/pairing-dialog";
import { readSystemClipboard } from "@/lib/clipboard";
import { pickFiles } from "@/lib/file-picker";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export const Route = createFileRoute("/")({
  component: DevicesPage,
});

function DevicesPage() {
  const store = useLyraStore();
  const devices = useLyraSelector((s) =>
    s.devices.filter((d) => d.showInMainList).sort((a, b) => Number(b.online) - Number(a.online)),
  );
  const localClipboard = useLyraSelector((s) => s.localClipboardText);
  const [query, setQuery] = useState("");
  const [pairOpen, setPairOpen] = useState(false);
  const [url, setUrl] = useState("");

  const filtered = devices.filter((d) => {
    const name = (d.nickname || d.name).toLowerCase();
    return name.includes(query.toLowerCase());
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
    store.startFileTransfer(
      [deviceId],
      files.map((f) => ({ name: f.name, size: f.size, mimeType: f.mimeType })),
    );
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

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-4xl border border-dashed border-border px-6 py-16 text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Plus className="size-5" />
          </div>
          <h2 className="font-medium">No paired devices yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Pair a phone or computer to sync clipboard and transfer files privately on your network.
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
                store.startFileTransfer(
                  [device.id],
                  files.map((f) => ({ name: f.name, size: f.size, mimeType: f.mimeType })),
                );
              }}
            />
          ))}
        </div>
      )}

      <PairingDialog open={pairOpen} onOpenChange={setPairOpen} />
    </div>
  );
}
