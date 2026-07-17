import { Button } from "@lyra-sync-app/ui/components/button";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export function IncomingPairBanner() {
  const store = useLyraStore();
  const requests = useLyraSelector((s) => s.incomingPairRequests);

  if (requests.length === 0) return null;
  const req = requests[0]!;

  return (
    <div className="border-b border-primary/20 bg-primary/10 px-4 py-3">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Pairing request from {req.payload.name}</p>
          <p className="text-xs text-muted-foreground">
            {req.payload.platform} · fingerprint {req.payload.fingerprint.slice(0, 8)}…
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => store.rejectIncomingPair(req.id)}>
            Decline
          </Button>
          <Button size="sm" onClick={() => store.confirmIncomingPair(req.id)}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
