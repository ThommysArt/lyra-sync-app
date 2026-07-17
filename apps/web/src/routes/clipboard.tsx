import { formatRelativeTime } from "@lyra-sync-app/core";
import { createFileRoute } from "@tanstack/react-router";
import { ClipboardPaste, Copy, Pin, PinOff, Send, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@lyra-sync-app/ui/components/button";
import { Card, CardContent } from "@lyra-sync-app/ui/components/card";
import { Textarea } from "@lyra-sync-app/ui/components/textarea";
import { readSystemClipboard, writeSystemClipboard } from "@/lib/clipboard";
import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export const Route = createFileRoute("/clipboard")({
  component: ClipboardPage,
});

function ClipboardPage() {
  const store = useLyraStore();
  const history = useLyraSelector((s) =>
    [...s.clipboardHistory].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.createdAt - a.createdAt;
    }),
  );
  const onlineDevices = useLyraSelector((s) => s.devices.filter((d) => d.online));
  const [draft, setDraft] = useState("");

  const importSystem = async () => {
    const text = await readSystemClipboard();
    if (text) {
      setDraft(text);
      store.setLocalClipboardText(text);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clipboard</h1>
          <p className="text-sm text-muted-foreground">
            Local history and multi-device send. Nothing leaves your network.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void importSystem()}>
            <ClipboardPaste className="size-4" />
            Read system
          </Button>
          <Button variant="outline" size="sm" onClick={() => store.clearClipboardHistory()}>
            Clear unpinned
          </Button>
        </div>
      </div>

      <Card className="rounded-4xl">
        <CardContent className="space-y-3 p-4">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type or paste text to send…"
            className="min-h-24 rounded-3xl"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!draft.trim()}
              onClick={() => {
                store.pushClipboardText(
                  draft,
                  onlineDevices.map((d) => d.id),
                );
                void writeSystemClipboard(draft.trim());
                setDraft("");
              }}
            >
              <Send className="size-4" />
              Send to all online
            </Button>
            <Button
              variant="secondary"
              disabled={!draft.trim()}
              onClick={() => {
                store.pushClipboardText(draft, []);
                void writeSystemClipboard(draft.trim());
                setDraft("");
              }}
            >
              Save to history
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {history.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No clipboard items yet.</p>
        ) : (
          history.map((item) => (
            <Card key={item.id} className="rounded-3xl">
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {item.text || (item.type === "image" ? "[Image]" : "—")}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {item.sourceDeviceName} · {formatRelativeTime(item.createdAt)}
                    {item.pinned ? " · Pinned" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => {
                      if (item.text) void writeSystemClipboard(item.text);
                    }}
                    title="Copy to system clipboard"
                  >
                    <Copy className="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => store.pinClipboardItem(item.id, !item.pinned)}
                    title={item.pinned ? "Unpin" : "Pin"}
                  >
                    {item.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      store.resendClipboardItem(
                        item.id,
                        onlineDevices.map((d) => d.id),
                      )
                    }
                    title="Resend"
                  >
                    <Send className="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => store.removeClipboardItem(item.id)}
                    title="Remove"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
