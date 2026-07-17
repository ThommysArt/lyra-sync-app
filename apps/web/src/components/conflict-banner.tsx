import type { ConflictAction } from "@lyra-sync-app/protocol";

import { Button } from "@lyra-sync-app/ui/components/button";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export function ConflictBanner() {
  const store = useLyraStore();
  const conflicts = useLyraSelector((s) =>
    s.transfers.filter((t) => t.status === "conflict"),
  );

  if (conflicts.length === 0) return null;
  const tx = conflicts[0]!;
  const name = tx.conflictFileName ?? tx.files[0]?.name ?? "file";

  const resolve = (action: ConflictAction) => {
    store.resolveTransferConflict(tx.id, action);
  };

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            “{name}” already exists on this device
          </p>
          <p className="text-xs text-muted-foreground">
            Incoming from {tx.deviceName} · choose how to resolve
            {conflicts.length > 1 ? ` · +${conflicts.length - 1} more` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => resolve("skip")}>
            Skip
          </Button>
          <Button variant="outline" size="sm" onClick={() => resolve("rename")}>
            Rename
          </Button>
          <Button size="sm" onClick={() => resolve("overwrite")}>
            Overwrite
          </Button>
        </div>
      </div>
    </div>
  );
}
