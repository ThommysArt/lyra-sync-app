/**
 * Per-device LAN + Tailscale address editor.
 * Makes 100.x / MagicDNS first-class (spec §4.3).
 */

import { isLikelyTailscaleHost } from "@lyra-sync-app/core";
import type { PairedDevice } from "@lyra-sync-app/protocol";
import { useEffect, useState } from "react";

import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lyra-sync-app/ui/components/card";
import { Input } from "@lyra-sync-app/ui/components/input";
import { Label } from "@lyra-sync-app/ui/components/label";
import { useLyraStore } from "@/lib/lyra";

export function DeviceAddressesCard({ device }: { device: PairedDevice }) {
  const store = useLyraStore();
  const [host, setHost] = useState(device.host ?? "");
  const [tsHost, setTsHost] = useState(device.tailscaleHost ?? "");
  const [port, setPort] = useState(String(device.port ?? 53317));
  const [adb, setAdb] = useState(device.adbSerial ?? "");
  const [preferred, setPreferred] = useState(device.preferredAddress ?? "auto");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHost(device.host ?? "");
    setTsHost(device.tailscaleHost ?? "");
    setPort(String(device.port ?? 53317));
    setAdb(device.adbSerial ?? "");
    setPreferred(device.preferredAddress ?? "auto");
  }, [
    device.id,
    device.host,
    device.tailscaleHost,
    device.port,
    device.adbSerial,
    device.preferredAddress,
  ]);

  const save = () => {
    const res = store.updateDeviceAddress(device.id, {
      host: host.trim() || null,
      tailscaleHost: tsHost.trim() || null,
      port: Number(port) || 53317,
      preferredAddress: preferred as PairedDevice["preferredAddress"],
      adbSerial: adb.trim() || null,
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    // Probe whichever host is preferred
    const probeHost =
      preferred === "tailscale"
        ? tsHost.trim() || host.trim()
        : host.trim() || tsHost.trim();
    if (probeHost) {
      void store.probePeerAddress({ host: probeHost, port: Number(port) || 53317 });
    }
  };

  const tsLooksValid = !tsHost.trim() || isLikelyTailscaleHost(tsHost.trim()) || tsHost.includes(".");

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="text-base">Connection addresses</CardTitle>
        <CardDescription>
          LAN and Tailscale IPs for this device. Multicast often fails over Tailscale — set the{" "}
          <code className="rounded bg-muted px-1 text-[11px]">100.x</code> address explicitly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`lan-${device.id}`} className="text-xs">
            LAN host / IP
          </Label>
          <Input
            id={`lan-${device.id}`}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.42"
            className="rounded-md font-mono text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ts-${device.id}`} className="text-xs">
            Tailscale IP or MagicDNS
          </Label>
          <Input
            id={`ts-${device.id}`}
            value={tsHost}
            onChange={(e) => setTsHost(e.target.value)}
            placeholder="100.83.145.32 or pixel-6.tailnet.ts.net"
            className="rounded-md font-mono text-sm"
          />
          {!tsLooksValid ? (
            <p className="text-xs text-amber-600">
              Expected CGNAT <code className="rounded bg-muted px-1">100.64–100.127.x.x</code> or{" "}
              <code className="rounded bg-muted px-1">*.ts.net</code>
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`port-${device.id}`} className="text-xs">
              Port
            </Label>
            <Input
              id={`port-${device.id}`}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="rounded-md font-mono text-sm"
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`pref-${device.id}`} className="text-xs">
              Prefer
            </Label>
            <select
              id={`pref-${device.id}`}
              value={preferred}
              onChange={(e) => setPreferred(e.target.value as typeof preferred)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
            >
              <option value="auto">Auto</option>
              <option value="lan">LAN</option>
              <option value="tailscale">Tailscale</option>
            </select>
          </div>
        </div>
        {(device.platform === "android" || device.type === "mobile") && (
          <div className="space-y-1.5">
            <Label htmlFor={`adb-${device.id}`} className="text-xs">
              ADB serial (scrcpy)
            </Label>
            <Input
              id={`adb-${device.id}`}
              value={adb}
              onChange={(e) => setAdb(e.target.value)}
              placeholder="100.83.145.32:5555"
              className="rounded-md font-mono text-sm"
            />
          </div>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button size="sm" onClick={save} className="w-full">
          Save addresses
        </Button>
      </CardContent>
    </Card>
  );
}
