import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useLyraSelector, useLyraStore } from "@/lib/lyra";

export function ToastListener() {
  const store = useLyraStore();
  const t = useLyraSelector((s) => s.toast);
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    if (!t || t.id === lastId.current) return;
    lastId.current = t.id;
    if (t.tone === "success") toast.success(t.message);
    else if (t.tone === "error") toast.error(t.message);
    else toast(t.message);
    // Defer dismiss so we don't re-enter during the same commit phase
    queueMicrotask(() => store.dismissToast());
  }, [t, store]);

  return null;
}
