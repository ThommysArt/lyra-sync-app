import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { generatePairingCode } from "@lyra-sync-app/core";
import { useLyra } from "@lyra-sync-app/hooks";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function useLyraState() {
  const store = useLyra();
  const [state, setState] = React.useState(() => store.getState());
  React.useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  return { store, state };
}

function HomeComponent() {
  const { store, state } = useLyraState();
  const [ipInput, setIpInput] = React.useState("");
  const [showPairing, setShowPairing] = React.useState(false);
  const [pairingCode, setPairingCode] = React.useState<string | null>(null);

  const pairedDevices = state.pairedDevices;
  const discovered = state.discovery.discovered;

  const handleRefresh = React.useCallback(() => {
    void store.refreshDiscovery();
  }, [store]);

  const handleAddByIp = React.useCallback(() => {
    const raw = ipInput.trim();
    if (!raw) return;
    // parse host:port or host
    const [host, portStr] = raw.split(":");
    const port = portStr ? Number.parseInt(portStr, 10) : 53317;
    if (!host) return;
    // ingest as discovered peer stub so UI shows something
    store.ingestDiscoveredPeer({
      identity: { id: `manual-${host}-${port}`, name: host, fingerprint: `manual-${host}` },
      host,
      port: Number.isFinite(port) ? port : 53317,
    });
    setIpInput("");
  }, [ipInput, store]);

  const handleGenerateCode = React.useCallback(() => {
    const code = generatePairingCode(6);
    setPairingCode(code);
    setShowPairing(true);
  }, []);

  return (
    <div className="container mx-auto max-w-3xl px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Devices</h1>
        <div className="flex gap-2">
          <button
            onClick={handleRefresh}
            className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            type="button"
          >
            Refresh
          </button>
          <button
            onClick={handleGenerateCode}
            className="inline-flex items-center rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm"
            type="button"
          >
            Pair a device
          </button>
        </div>
      </div>

      {/* Paired devices */}
      <section className="rounded-lg border p-4 mb-6">
        <h2 className="mb-3 font-medium">Paired devices</h2>
        {pairedDevices.length === 0 ? (
          <div className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
            <p className="mb-3">No paired devices yet.</p>
            <button
              onClick={handleGenerateCode}
              className="inline-flex rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm"
              type="button"
            >
              Pair a device
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {pairedDevices.map((d) => (
              <li key={d.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <div className="font-medium text-sm">{d.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {d.id} · {d.fingerprint.slice(0, 8)} · {d.host ?? d.lastReachableHost ?? "no host"}:{d.port ?? d.lastReachablePort ?? "-"}
                  </div>
                </div>
                <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5 dark:bg-green-900 dark:text-green-100">
                  {d.status ?? "offline"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Discovered */}
      <section className="rounded-lg border p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium">Discovered</h2>
          <button onClick={handleRefresh} className="text-xs underline" type="button">
            Refresh
          </button>
        </div>
        {discovered.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices discovered on LAN. Tap Refresh or add by IP.</p>
        ) : (
          <ul className="space-y-2">
            {discovered.map((p) => (
              <li key={`${p.identity.id}-${p.host}:${p.port}`} className="rounded-md border px-3 py-2">
                <div className="font-medium text-sm">{p.identity.name}</div>
                <div className="text-xs text-muted-foreground">
                  {p.host}:{p.port} · {p.identity.fingerprint.slice(0, 8)}
                  {p.pairing ? ` · pairing ${p.pairing.codeHash.slice(0, 6)}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Add by IP */}
      <section className="rounded-lg border p-4 mb-6">
        <h2 className="mb-3 font-medium">Add by IP</h2>
        <div className="flex gap-2">
          <input
            value={ipInput}
            onChange={(e) => setIpInput(e.target.value)}
            placeholder="192.168.1.10:53317"
            className="flex-1 rounded-md border px-3 py-1.5 text-sm bg-background"
          />
          <button
            onClick={handleAddByIp}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm"
            type="button"
          >
            Add
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">Enter host and optional port. Will appear under Discovered.</p>
      </section>

      {/* Pairing dialog stub */}
      {showPairing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowPairing(false)}>
          <div
            className="w-full max-w-sm rounded-lg bg-background border p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-2">Pair a device</h3>
            <p className="text-sm text-muted-foreground mb-3">Share this code with the other device. Code expires in a few minutes.</p>
            <div className="rounded-md bg-muted p-4 text-center font-mono text-2xl tracking-widest mb-4">
              {pairingCode ?? generatePairingCode(6)}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowPairing(false)} className="rounded-md border px-3 py-1.5 text-sm" type="button">
                Close
              </button>
              <button
                onClick={() => setPairingCode(generatePairingCode(6))}
                className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm"
                type="button"
              >
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-4 text-sm">
        <Link to="/transfers" className="underline">Transfers</Link>
        <Link to="/clipboard" className="underline">Clipboard</Link>
      </div>
    </div>
  );
}
