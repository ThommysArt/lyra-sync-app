import { formatFingerprint } from "@lyra-sync-app/core";
import { QrCode, Shuffle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { toast } from "sonner";

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
  const outbound = useLyraSelector((s) => s.outboundPairing);
  const peerRunning = useLyraSelector((s) => s.peerServer.running);
  const lanHost = useLyraSelector((s) => s.peerServer.lanHost ?? s.localLanHint);
  const [code, setCode] = useState("");
  const [hostHint, setHostHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("show");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  const startSession = () => {
    const session = store.startPairingSession();
    toast.message(`Sharing code ${session.code}`, {
      description: peerRunning
        ? "Other devices can enter this code on the same Wi‑Fi."
        : "Peer server idle — run the desktop app so others can find this code.",
    });
  };

  const onSubmitCode = () => {
    setBusy(true);
    setError(null);
    void store
      .submitPairingCode(code, hostHint.trim() ? { host: hostHint.trim() } : undefined)
      .then((result) => {
        if (result.ok) {
          setCode("");
          setError(null);
          if ("device" in result) {
            toast.success(`Paired with ${result.device.name}`);
            setOpen(false);
          } else {
            toast.message("Waiting for the other device to accept…");
          }
        } else {
          setError(result.error);
          toast.error(result.error);
        }
      })
      .finally(() => setBusy(false));
  };

  const qrValue = active ? JSON.stringify(active.payload) : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Do NOT auto-start a code when opening "Enter code" — only host when
        // the user is on Show code (or taps Generate). Hosting without the
        // peer server advertising the offer is the #1 cause of "not found".
        if (next && tab === "show" && !store.getState().activePairing && peerRunning) {
          startSession();
        }
      }}
    >
      {trigger ? <DialogTrigger render={trigger as never} /> : null}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>
            <strong>Desktop shows the code</strong> (peer server must be running). The other device
            enters it. Expo Go can enter a code but cannot host one.
          </DialogDescription>
        </DialogHeader>

        {outbound?.status === "waiting" ? (
          <p className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
            Waiting for <strong>{outbound.hostName}</strong> to accept pairing…
          </p>
        ) : null}

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v);
            if (v === "show" && !store.getState().activePairing && peerRunning) {
              startSession();
            }
          }}
        >
          <TabsList className="grid w-full grid-cols-2 rounded-md">
            <TabsTrigger value="show" className="rounded-md">
              Show code
            </TabsTrigger>
            <TabsTrigger value="enter" className="rounded-md">
              Enter code
            </TabsTrigger>
          </TabsList>

          <TabsContent value="show" className="space-y-4 pt-3">
            {!peerRunning ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Peer server is idle — other devices cannot discover this code. Use the{" "}
                <strong>desktop app</strong> (not browser-only / not Expo Go as host).
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Advertising on {lanHost ?? "LAN"}:{store.getState().peerServer.port ?? 53317}
                {active ? " · offer active" : ""}
              </p>
            )}
            {active ? (
              <>
                <div className="mx-auto w-fit rounded-xl bg-white p-4 shadow-sm ring-1 ring-border/60">
                  <QRCodeSVG
                    value={qrValue}
                    size={200}
                    level="M"
                    includeMargin={false}
                    bgColor="#ffffff"
                    fgColor="#0B1220"
                    aria-label="Pairing QR code"
                  />
                </div>
                <div className="text-center">
                  <p className="text-xs text-muted-foreground">Pairing code</p>
                  <p className="mt-1 font-mono text-3xl font-semibold tracking-[0.25em] text-primary">
                    {active.code}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Leave this open (or use Stop sharing). You will be asked to accept when the other
                    device connects.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Fingerprint {formatFingerprint(identity?.fingerprint ?? "")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={startSession}>
                    <Shuffle className="size-4" />
                    Refresh code
                  </Button>
                  <Button
                    variant="ghost"
                    className="flex-1"
                    onClick={() => {
                      store.cancelPairingSession();
                      toast.message("Stopped sharing code");
                    }}
                  >
                    Stop sharing
                  </Button>
                </div>
              </>
            ) : (
              <Button className="w-full" onClick={startSession} disabled={!peerRunning}>
                <QrCode className="size-4" />
                Generate pairing code
              </Button>
            )}
          </TabsContent>

          <TabsContent value="enter" className="space-y-3 pt-3">
            <div className="space-y-2">
              <Label htmlFor="pair-code">Code from desktop</Label>
              <Input
                id="pair-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                className="rounded-md text-center font-mono text-lg tracking-widest"
                maxLength={8}
                disabled={busy}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pair-host">Desktop IP (optional)</Label>
              <Input
                id="pair-host"
                value={hostHint}
                onChange={(e) => setHostHint(e.target.value)}
                placeholder="192.168.1.152"
                className="rounded-md font-mono text-sm"
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                If scan fails (common on Expo Go / guest Wi‑Fi), paste the desktop LAN IP from
                Settings → Network.
              </p>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button className="w-full" onClick={onSubmitCode} disabled={busy || code.length < 4}>
              {busy ? "Searching network…" : "Start pairing"}
            </Button>
            {import.meta.env.VITE_LYRA_SEED_DEMO === "1" ||
            import.meta.env.VITE_LYRA_SEED_DEMO === "true" ? (
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => store.simulateIncomingPair()}
              >
                Simulate incoming request
              </Button>
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
