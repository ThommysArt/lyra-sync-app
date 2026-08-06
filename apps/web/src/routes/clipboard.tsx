import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useLyra } from "@lyra-sync-app/hooks";

export const Route = createFileRoute("/clipboard")({
  component: ClipboardComponent,
});

function useLyraState() {
  const store = useLyra();
  const [state, setState] = React.useState(() => store.getState());
  React.useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  return { store, state };
}

function ClipboardComponent() {
  const { store, state } = useLyraState();
  const [text, setText] = React.useState("");
  const history = state.clipboard.history;

  const handleSend = React.useCallback(() => {
    const v = text.trim();
    if (!v) return;
    // task says pushClipboardText — current store exposes both pushClipboard and pushClipboardText
    const anyStore = store as unknown as { pushClipboardText?: (t: string) => void; pushClipboard?: (t: string) => void };
    if (anyStore.pushClipboardText) anyStore.pushClipboardText(v);
    else if (anyStore.pushClipboard) anyStore.pushClipboard(v);
    else store.pushClipboard(v);
    setText("");
  }, [store, text]);

  const handleClear = React.useCallback(() => {
    state.clipboard.clearHistory();
  }, [state.clipboard]);

  const handlePin = React.useCallback((id: string) => {
    state.clipboard.pinItem(id);
  }, [state.clipboard]);

  return (
    <div className="container mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-semibold mb-4">Clipboard</h1>

      <section className="rounded-lg border p-4 mb-6">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type text to send to paired devices..."
          className="w-full min-h-24 rounded-md border bg-background px-3 py-2 text-sm"
        />
        <div className="flex justify-end mt-3 gap-2">
          <button onClick={handleSend} className="rounded-md bg-primary text-primary-foreground px-4 py-1.5 text-sm" type="button">
            Send
          </button>
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium">History</h2>
          <button onClick={handleClear} className="text-xs underline" type="button">
            Clear
          </button>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No clipboard history yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((item) => (
              <li key={item.id} className="flex items-start justify-between rounded-md border px-3 py-2 gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm break-words whitespace-pre-wrap">{item.text.slice(0, 500)}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {new Date(item.createdAt).toLocaleString()} · {item.type ?? "text"}
                  </div>
                </div>
                <button onClick={() => handlePin(item.id)} className="shrink-0 rounded-md border px-2 py-1 text-xs" type="button">
                  Pin
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
