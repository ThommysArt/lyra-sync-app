import { Button, Card } from "heroui-native";
import * as React from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { generatePairingCode } from "@lyra-sync-app/core";
import { useLyra } from "@lyra-sync-app/hooks";

import { Container } from "@/components/container";

function useLyraState() {
  const store = useLyra();
  const [state, setState] = React.useState(() => store.getState());
  React.useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  return { store, state };
}

// P4 Clipboard sync — iOS cannot monitor automatically — use Send Clipboard
// Mobile uses expo-clipboard with manual "Read system" button (see expo-clipboard docs).
// This label is required per spec P4.
export default function Home() {
  const { store, state } = useLyraState();
  const [ipInput, setIpInput] = React.useState("");
  const [clipText, setClipText] = React.useState("");
  const [pairingCode, setPairingCode] = React.useState<string | null>(null);

  const pairedDevices = state.pairedDevices;
  const discovered = state.discovery.discovered;
  const transfers = (state.transfers as unknown as { sessions?: Record<string, { id: string; deviceName?: string; totalBytes?: number; transferredBytes?: number; status?: string }> }).sessions ?? {};
  const transferList = Object.values(transfers);

  const handleRefresh = React.useCallback(() => {
    void store.refreshDiscovery();
  }, [store]);

  const handleAddByIp = React.useCallback(() => {
    const raw = ipInput.trim();
    if (!raw) return;
    const [host, portStr] = raw.split(":");
    const port = portStr ? Number.parseInt(portStr, 10) : 53317;
    if (!host) return;
    store.ingestDiscoveredPeer({
      identity: { id: `manual-${host}-${port}`, name: host, fingerprint: `manual-${host}` },
      host,
      port: Number.isFinite(port) ? port : 53317,
    });
    setIpInput("");
  }, [ipInput, store]);

  const handleSendClipboard = React.useCallback(() => {
    const v = clipText.trim();
    if (!v) return;
    const anyStore = store as unknown as { pushClipboardText?: (t: string) => void; pushClipboard?: (t: string) => void };
    if (anyStore.pushClipboardText) anyStore.pushClipboardText(v);
    else if (anyStore.pushClipboard) anyStore.pushClipboard(v);
    else store.pushClipboard(v);
    setClipText("");
  }, [clipText, store]);

  return (
    <Container className="p-6">
      <ScrollView showsVerticalScrollIndicator={false}>
        <View className="gap-6">
          <Card variant="secondary" className="p-4">
            <Card.Title className="text-xl mb-1">Devices</Card.Title>
            <View className="flex-row gap-2 mt-3">
              <Button variant="secondary" size="sm" onPress={handleRefresh}>
                <Text>Refresh</Text>
              </Button>
              <Button
                size="sm"
                onPress={() => setPairingCode(generatePairingCode(6))}
              >
                <Text>Pair a device</Text>
              </Button>
            </View>
            {pairingCode ? (
              <View className="mt-3 rounded-md bg-muted p-3 items-center">
                <Text className="font-mono text-lg tracking-widest">{pairingCode}</Text>
                <Text className="text-xs opacity-60 mt-1">code from generatePairingCode</Text>
              </View>
            ) : null}
          </Card>

          <View className="rounded-lg border p-3">
            <Text className="font-medium mb-2">Paired devices</Text>
            {pairedDevices.length === 0 ? (
              <View className="rounded-md bg-muted p-3">
                <Text className="text-sm opacity-70 mb-2">No paired devices yet.</Text>
                <Button size="sm" onPress={() => setPairingCode(generatePairingCode(6))}>
                  <Text>Pair a device</Text>
                </Button>
              </View>
            ) : (
              <View className="gap-2">
                {pairedDevices.map((d) => (
                  <View key={d.id} className="rounded-md border p-2">
                    <Text className="font-medium text-sm">{d.name}</Text>
                    <Text className="text-xs opacity-60">{d.id} · {d.fingerprint.slice(0, 8)} · {d.host ?? d.lastReachableHost ?? "-"}:{d.port ?? d.lastReachablePort ?? "-"}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View className="rounded-lg border p-3">
            <View className="flex-row justify-between items-center mb-2">
              <Text className="font-medium">Discovered</Text>
              <Button variant="ghost" size="sm" onPress={handleRefresh}>
                <Text>Refresh</Text>
              </Button>
            </View>
            {discovered.length === 0 ? (
              <Text className="text-sm opacity-60">No devices discovered. Tap Refresh or add by IP.</Text>
            ) : (
              <View className="gap-2">
                {discovered.map((p) => (
                  <View key={`${p.identity.id}-${p.host}:${p.port}`} className="rounded-md border p-2">
                    <Text className="text-sm font-medium">{p.identity.name}</Text>
                    <Text className="text-xs opacity-60">{p.host}:{p.port} · {p.identity.fingerprint.slice(0, 8)}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View className="rounded-lg border p-3">
            <Text className="font-medium mb-2">Add by IP</Text>
            <View className="flex-row gap-2">
              <TextInput
                value={ipInput}
                onChangeText={setIpInput}
                placeholder="192.168.1.10:53317"
                className="flex-1 rounded-md border px-3 py-2 text-sm"
                placeholderTextColor="#999"
              />
              <Button size="sm" onPress={handleAddByIp}>
                <Text>Add</Text>
              </Button>
            </View>
          </View>

          <View className="rounded-lg border p-3">
            <Text className="font-medium mb-2">Clipboard</Text>
            <Text className="text-xs opacity-60 mb-2">iOS cannot monitor automatically — use Send Clipboard</Text>
            <TextInput
              value={clipText}
              onChangeText={setClipText}
              placeholder="Type text to send..."
              multiline
              className="min-h-20 rounded-md border px-3 py-2 text-sm"
              placeholderTextColor="#999"
            />
            <View className="mt-2 flex-row justify-end">
              <Button size="sm" onPress={handleSendClipboard}>
                <Text>Send</Text>
              </Button>
            </View>
            <View className="mt-3 gap-2">
              {state.clipboard.history.slice(0, 20).map((item) => (
                <View key={item.id} className="rounded-md border p-2 flex-row justify-between gap-2">
                  <Text className="flex-1 text-sm" numberOfLines={2}>{item.text}</Text>
                  <Button variant="ghost" size="sm" onPress={() => state.clipboard.pinItem(item.id)}>
                    <Text>Pin</Text>
                  </Button>
                </View>
              ))}
              {state.clipboard.history.length > 0 ? (
                <Button variant="ghost" size="sm" onPress={() => state.clipboard.clearHistory()}>
                  <Text>Clear</Text>
                </Button>
              ) : (
                <Text className="text-xs opacity-60">No history yet.</Text>
              )}
            </View>
          </View>

          <View className="rounded-lg border p-3">
            <Text className="font-medium mb-2">Transfers</Text>
            {transferList.length === 0 ? (
              <Text className="text-sm opacity-60">No transfers.</Text>
            ) : (
              <View className="gap-2">
                {transferList.map((s) => {
                  const total = s.totalBytes ?? 0;
                  const done = s.transferredBytes ?? 0;
                  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                  return (
                    <View key={s.id} className="rounded-md border p-2">
                      <View className="flex-row justify-between mb-1">
                        <Text className="text-sm font-medium">{s.id}</Text>
                        <Text className="text-xs opacity-60">{s.status}</Text>
                      </View>
                      <Text className="text-xs opacity-60">{done}/{total} bytes · {pct}%</Text>
                      <View className="h-2 rounded-full bg-muted mt-1 overflow-hidden">
                        <View className="h-full bg-primary" style={{ width: `${pct}%` as unknown as number }} />
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </Container>
  );
}
