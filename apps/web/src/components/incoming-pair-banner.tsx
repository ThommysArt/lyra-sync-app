import { useState } from "react";

import { Button } from "@lyra-sync-app/ui/components/button";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export function IncomingPairBanner() {
  const store = useLyraStore();
  const requests = useLyraSelector((s) => s.incomingPairRequests);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (requests.length === 0) return null;
  const req = requests[0]!;
  const busy = busyId === req.id;

  return (
    <div className="border-b border-primary/20 bg-primary/10 px-4 py-3">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Accept pairing with {req.payload.name}?</p>
          <p className="text-xs text-muted-foreground">
            {req.payload.platform} · fingerprint {req.payload.fingerprint.slice(0, 8)}… · Accept to
            pair both devices
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => store.rejectIncomingPair(req.id)}
          >
            Decline
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusyId(req.id);
              void Promise.resolve(store.confirmIncomingPair(req.id)).finally(() => setBusyId(null));
            }}
          >
            {busy ? "Pairing…" : "Accept"}
          </Button>
        </div>
      </div>
    </div>
  );
}
