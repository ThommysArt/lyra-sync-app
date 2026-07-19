import type { ConflictAction, Transfer } from "@lyra-sync-app/protocol";
import { formatBytes } from "@lyra-sync-app/core";
import { useState } from "react";

import { Button } from "@lyra-sync-app/ui/components/button";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

function namesFor(tx: Transfer): string[] {
  if (tx.conflictFileNames && tx.conflictFileNames.length > 0) {
    return tx.conflictFileNames;
  }
  if (tx.conflictFileName) return [tx.conflictFileName];
  return tx.files.map((f) => f.name);
}

export function ConflictBanner() {
  const store = useLyraStore();
  const conflicts = useLyraSelector((s) => s.transfers.filter((t) => t.status === "conflict"));
  const [expanded, setExpanded] = useState(true);

  if (conflicts.length === 0) return null;

  const totalFiles = conflicts.reduce((acc, tx) => acc + namesFor(tx).length, 0);
  const multiSession = conflicts.length > 1;
  const multiFile = totalFiles > 1;

  const resolveOne = (id: string, action: ConflictAction) => {
    store.resolveTransferConflict(id, action);
  };

  const resolveAll = (action: ConflictAction) => {
    store.resolveAllTransferConflicts(action);
  };

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <div className="mx-auto max-w-5xl space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {multiFile
                ? `${totalFiles} files already exist on this device`
                : `“${namesFor(conflicts[0]!)[0] ?? "file"}” already exists on this device`}
            </p>
            <p className="text-xs text-muted-foreground">
              {multiSession
                ? `${conflicts.length} incoming sessions need a decision`
                : `Incoming from ${conflicts[0]!.deviceName} · choose how to resolve`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(multiSession || multiFile) && (
              <>
                <Button variant="outline" size="sm" onClick={() => resolveAll("skip")}>
                  Skip all
                </Button>
                <Button variant="outline" size="sm" onClick={() => resolveAll("rename")}>
                  Rename all
                </Button>
                <Button size="sm" onClick={() => resolveAll("overwrite")}>
                  Overwrite all
                </Button>
              </>
            )}
            {!multiSession && !multiFile && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resolveOne(conflicts[0]!.id, "skip")}
                >
                  Skip
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resolveOne(conflicts[0]!.id, "rename")}
                >
                  Rename
                </Button>
                <Button size="sm" onClick={() => resolveOne(conflicts[0]!.id, "overwrite")}>
                  Overwrite
                </Button>
              </>
            )}
            {(multiSession || multiFile) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
              >
                {expanded ? "Hide details" : "Show details"}
              </Button>
            )}
          </div>
        </div>

        {expanded && (multiSession || multiFile) && (
          <ul className="space-y-2">
            {conflicts.map((tx) => {
              const names = namesFor(tx);
              return (
                <li
                  key={tx.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-background/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {names.length <= 2
                        ? names.join(", ")
                        : `${names.slice(0, 2).join(", ")} +${names.length - 2} more`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      From {tx.deviceName} · {formatBytes(tx.totalBytes)} · {names.length} file
                      {names.length === 1 ? "" : "s"}
                    </p>
                    {names.length > 2 && (
                      <p className="mt-1 text-xs text-muted-foreground">{names.join(" · ")}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolveOne(tx.id, "skip")}
                    >
                      Skip
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolveOne(tx.id, "rename")}
                    >
                      Rename
                    </Button>
                    <Button size="sm" onClick={() => resolveOne(tx.id, "overwrite")}>
                      Overwrite
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
