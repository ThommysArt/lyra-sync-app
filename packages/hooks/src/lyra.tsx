import * as React from "react";
import { createLyraStore, type LyraStore, type LyraStoreOptions } from "@lyra-sync-app/core";

type LyraContextValue = LyraStore;

const LyraContext = React.createContext<LyraContextValue | null>(null);

export function createLyraContext(opts: LyraStoreOptions): LyraContextValue {
  return createLyraStore(opts);
}

export function LyraProvider(props: { store: LyraStore; children: React.ReactNode }): React.JSX.Element {
  return React.createElement(LyraContext.Provider, { value: props.store }, props.children);
}

export function useLyra(): LyraStore {
  const ctx = React.useContext(LyraContext);
  if (!ctx) throw new Error("useLyra must be used within LyraProvider");
  return ctx;
}

export { LyraContext };
