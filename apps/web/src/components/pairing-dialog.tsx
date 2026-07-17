import { formatFingerprint } from "@lyra-sync-app/core";
import { QrCode, Shuffle } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@lyra-sync-app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@lyra-sync-app/ui/components/dialog";
import { Input } from "@lyra-sync-app/ui/components/input";
import { Label } from "@lyra-sync-app/ui/components/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@lyra-sync-app/ui/components/tabs";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

/** Minimal QR-like visual from pairing payload (no external QR lib required). */
function PairingQrPlaceholder({ value }: { value: string }) {
  const cells = useMemo(() => {
    const size = 21;
    const grid: boolean[][] = [];
    let h = 0;
    for (let i = 0; i < value.length; i++) h = (h * 33 + value.charCodeAt(i)) >>> 0;
    for (let y = 0; y < size; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < size; x++) {
        const border = x === 0 || y === 0 || x === size - 1 || y === size - 1;
        const finder =
          (x < 7 && y < 7) || (x > size - 8 && y < 7) || (x < 7 && y > size - 8);
        if (border || finder) {
          row.push(true);
        } else {
          const bit = (h ^ (x * 73856093) ^ (y * 19349663)) & 1;
          row.push(bit === 1);
        }
      }
      grid.push(row);
    }
    return grid;
  }, [value]);

  return (
    <div
      className="mx-auto grid w-fit gap-px rounded-2xl bg-foreground p-3"
      style={{ gridTemplateColumns: `repeat(${cells[0]?.length ?? 0}, 8px)` }}
      aria-label="Pairing QR code"
    >
      {cells.flatMap((row, y) =>
        row.map((on, x) => (
          <div
            key={`${y}-${x}`}
            className={on ? "size-2 bg-background" : "size-2 bg-foreground"}
          />
        )),
      )}
    </div>
  );
}

export function PairingDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const store = useLyraStore();
  const identity = useLyraSelector((s) => s.identity);
  const active = useLyraSelector((s) => s.activePairing);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  const startSession = () => {
    store.startPairingSession();
  };

  const onSubmitCode = () => {
    const result = store.submitPairingCode(code);
    if (result.ok) {
      setCode("");
      setError(null);
      setOpen(false);
    } else {
      setError(result.error);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !active) startSession();
        if (!next) store.cancelPairingSession();
      }}
    >
      {trigger ? <DialogTrigger render={trigger as never} /> : null}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>
            Scan the QR code or enter a pairing code. Both devices must confirm.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="show">
          <TabsList className="grid w-full grid-cols-2 rounded-full">
            <TabsTrigger value="show" className="rounded-full">
              Show code
            </TabsTrigger>
            <TabsTrigger value="enter" className="rounded-full">
              Enter code
            </TabsTrigger>
          </TabsList>

          <TabsContent value="show" className="space-y-4 pt-3">
            {active ? (
              <>
                <PairingQrPlaceholder value={JSON.stringify(active.payload)} />
                <div className="text-center">
                  <p className="text-xs text-muted-foreground">Pairing code</p>
                  <p className="mt-1 font-mono text-3xl font-semibold tracking-[0.25em] text-primary">
                    {active.code}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Fingerprint {formatFingerprint(identity?.fingerprint ?? "")}
                  </p>
                </div>
                <Button variant="outline" className="w-full" onClick={startSession}>
                  <Shuffle className="size-4" />
                  Refresh code
                </Button>
              </>
            ) : (
              <Button className="w-full" onClick={startSession}>
                <QrCode className="size-4" />
                Generate pairing code
              </Button>
            )}
          </TabsContent>

          <TabsContent value="enter" className="space-y-3 pt-3">
            <div className="space-y-2">
              <Label htmlFor="pair-code">Code from other device</Label>
              <Input
                id="pair-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                className="rounded-full text-center font-mono text-lg tracking-widest"
                maxLength={8}
              />
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </div>
            <Button className="w-full" onClick={onSubmitCode}>
              Pair device
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => store.simulateIncomingPair()}
            >
              Simulate incoming request
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
