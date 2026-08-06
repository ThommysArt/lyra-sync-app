import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useLyra } from "@lyra-sync-app/hooks";

export const Route = createFileRoute("/transfers")({
  component: TransfersComponent,
});

function useLyraState() {
  const store = useLyra();
  const [state, setState] = React.useState(() => store.getState());
  React.useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  return { store, state };
}

function TransfersComponent() {
  const { state } = useLyraState();
  // task says `transfers.sessions` — support both sessions and legacy transfers
  const transferState = state.transfers as unknown as {
    sessions?: Record<string, { id: string; deviceName?: string; deviceId?: string; files?: Array<{ name: string }>; totalBytes?: number; transferredBytes?: number; status?: string }>;
    transfers?: Record<string, unknown>;
  };
  const sessions = transferState.sessions ?? (transferState.transfers as Record<string, { id?: string; files?: Array<{ name: string }>; totalBytes?: number; transferredBytes?: number; status?: string }> | undefined) ?? {};
  const list = Object.values(sessions) as Array<{ id: string; deviceName?: string; deviceId?: string; files?: Array<{ name: string }>; totalBytes?: number; transferredBytes?: number; status?: string }>;

  return (
    <div className="container mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-semibold mb-4">Transfers</h1>
      {list.length === 0 ? (
        <div className="rounded-lg border p-6 text-sm text-muted-foreground">No transfers yet. Start a file transfer from a paired device.</div>
      ) : (
        <ul className="space-y-3">
          {list.map((s) => {
            const id = s.id ?? (s as unknown as { transferId?: string }).transferId ?? Math.random().toString(36).slice(2);
            const total = s.totalBytes ?? 0;
            const done = s.transferredBytes ?? 0;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <li key={id} className="rounded-lg border p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-medium text-sm">{s.files?.[0]?.name ?? id} {s.files && s.files.length > 1 ? `+${s.files.length - 1} more` : ""}</div>
                  <span className="text-xs rounded-full border px-2 py-0.5">{s.status ?? "pending"}</span>
                </div>
                <div className="text-xs text-muted-foreground mb-2">
                  {s.deviceName ?? s.deviceId ?? "unknown device"} · {done} / {total} bytes
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="text-xs text-muted-foreground mt-1">{pct}%</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
