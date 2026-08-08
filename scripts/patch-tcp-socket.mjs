#!/usr/bin/env node
/**
 * Postinstall patch for react-native-tcp-socket
 * Prevents java.lang.IllegalArgumentException: No socket with id N
 * which crashes the app when destroy()/write() race on background thread.
 *
 * This mirrors the logic in apps/native/plugins/with-tcp-socket-crash-fix.js
 * but runs at `pnpm install` time so `expo start` without prebuild is also safe.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function patchJavaFile(javaPath) {
  if (!fs.existsSync(javaPath)) return false;
  let src = fs.readFileSync(javaPath, "utf8");
  const orig = src;
  if (src.includes('No socket with id " + id + " (already closed or never created)')) {
    return false;
  }
  // Same patches as in with-tcp-socket-crash-fix.js – keep in sync
  src = src.replace(
    /private TcpSocketClient getTcpClient\(final int id\) \{[\s\S]*?return \(TcpSocketClient\) socket;\s*\}/,
    `private @Nullable TcpSocketClient getTcpClient(final int id) {
        TcpSocket socket = socketMap.get(id);
        if (socket == null) {
            Log.w(TAG, "No socket with id " + id + " (already closed or never created)");
            return null;
        }
        if (!(socket instanceof TcpSocketClient)) {
            Log.w(TAG, "Socket with id " + id + " is not a client");
            return null;
        }
        return (TcpSocketClient) socket;
    }`
  );
  src = src.replace(
    /private TcpSocketServer getTcpServer\(final int id\) \{[\s\S]*?return \(TcpSocketServer\) socket;\s*\}/,
    `private @Nullable TcpSocketServer getTcpServer(final int id) {
        TcpSocket socket = socketMap.get(id);
        if (socket == null) {
            Log.w(TAG, "No server socket with id " + id);
            return null;
        }
        if (!(socket instanceof TcpSocketServer)) {
            Log.w(TAG, "Server socket with id " + id + " is not a server");
            return null;
        }
        return (TcpSocketServer) socket;
    }`
  );
  if (!src.includes("import androidx.annotation.Nullable;")) {
    src = src.replace(
      "import androidx.annotation.NonNull;",
      "import androidx.annotation.NonNull;\nimport androidx.annotation.Nullable;"
    );
  }
  src = src.replace(
    /public void write\(final int cId, @NonNull final String base64String, final int msgId\) \{\s*TcpSocketClient socketClient = getTcpClient\(cId\);\s*byte\[\] data = Base64\.decode\(base64String, Base64\.NO_WRAP\);\s*socketClient\.write\(msgId, data\);\s*\}/,
    `public void write(final int cId, @NonNull final String base64String, final int msgId) {
        TcpSocketClient socketClient = getTcpClient(cId);
        if (socketClient == null) {
            Log.w(TAG, "write: no socket with id " + cId + " (already closed) — ignoring");
            return;
        }
        byte[] data = Base64.decode(base64String, Base64.NO_WRAP);
        socketClient.write(msgId, data);
    }`
  );
  src = src.replace(
    /public void end\(final Integer cId\) \{\s*executorService\.execute\(new Runnable\(\) \{\s*@Override\s*public void run\(\) \{\s*TcpSocketClient socketClient = getTcpClient\(cId\);\s*socketClient\.destroy\(\);\s*\}\s*\}\);\s*\}/,
    `public void end(final Integer cId) {
        executorService.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    TcpSocketClient socketClient = getTcpClient(cId);
                    if (socketClient == null) {
                        Log.w(TAG, "end/destroy: no socket with id " + cId + " (already closed) — ignoring");
                        return;
                    }
                    socketClient.destroy();
                    socketMap.remove(cId);
                    pendingTLS.remove(cId);
                } catch (Exception e) {
                    Log.w(TAG, "end/destroy error for id " + cId, e);
                    try { tcpEvtListener.onError(cId, e); } catch (Exception ignored) {}
                }
            }
        });
    }`
  );
  src = src.replace(
    /public void close\(final Integer cId\) \{\s*executorService\.execute\(new Runnable\(\) \{\s*@Override\s*public void run\(\) \{\s*TcpSocketServer socketServer = getTcpServer\(cId\);\s*socketServer\.close\(\);\s*socketMap\.remove\(cId\);\s*\}\s*\}\);\s*\}/,
    `public void close(final Integer cId) {
        executorService.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    TcpSocketServer socketServer = getTcpServer(cId);
                    if (socketServer == null) {
                        Log.w(TAG, "close: no server socket with id " + cId + " — ignoring");
                        return;
                    }
                    socketServer.close();
                    socketMap.remove(cId);
                } catch (Exception e) {
                    Log.w(TAG, "close error for id " + cId, e);
                    try { tcpEvtListener.onError(cId, e); } catch (Exception ignored) {}
                }
            }
        });
    }`
  );
  src = src.replace(
    /public void setNoDelay\(@NonNull final Integer cId, final boolean noDelay\) \{\s*final TcpSocketClient client = getTcpClient\(cId\);\s*try \{\s*client\.setNoDelay\(noDelay\);\s*\} catch \(IOException e\) \{\s*tcpEvtListener\.onError\(cId, e\);\s*\}\s*\}/,
    `public void setNoDelay(@NonNull final Integer cId, final boolean noDelay) {
        final TcpSocketClient client = getTcpClient(cId);
        if (client == null) {
            Log.w(TAG, "setNoDelay: no socket with id " + cId + " — ignoring");
            return;
        }
        try {
            client.setNoDelay(noDelay);
        } catch (IOException e) {
            tcpEvtListener.onError(cId, e);
        } catch (Exception e) {
            Log.w(TAG, "setNoDelay error for id " + cId, e);
        }
    }`
  );
  src = src.replace(
    /public void setKeepAlive\(@NonNull final Integer cId, final boolean enable, final int initialDelay\) \{\s*final TcpSocketClient client = getTcpClient\(cId\);\s*try \{\s*client\.setKeepAlive\(enable, initialDelay\);\s*\} catch \(IOException e\) \{\s*tcpEvtListener\.onError\(cId, e\);\s*\}\s*\}/,
    `public void setKeepAlive(@NonNull final Integer cId, final boolean enable, final int initialDelay) {
        final TcpSocketClient client = getTcpClient(cId);
        if (client == null) {
            Log.w(TAG, "setKeepAlive: no socket with id " + cId + " — ignoring");
            return;
        }
        try {
            client.setKeepAlive(enable, initialDelay);
        } catch (IOException e) {
            tcpEvtListener.onError(cId, e);
        } catch (Exception e) {
            Log.w(TAG, "setKeepAlive error for id " + cId, e);
        }
    }`
  );
  src = src.replace(
    /public void pause\(final int cId\) \{\s*TcpSocketClient client = getTcpClient\(cId\);\s*client\.pause\(\);\s*\}/,
    `public void pause(final int cId) {
        TcpSocketClient client = getTcpClient(cId);
        if (client == null) {
            Log.w(TAG, "pause: no socket with id " + cId + " — ignoring");
            return;
        }
        try { client.pause(); } catch (Exception e) { Log.w(TAG, "pause error for id " + cId, e); }
    }`
  );
  src = src.replace(
    /public void resume\(final int cId\) \{\s*TcpSocketClient client = getTcpClient\(cId\);\s*client\.resume\(\);\s*\}/,
    `public void resume(final int cId) {
        TcpSocketClient client = getTcpClient(cId);
        if (client == null) {
            Log.w(TAG, "resume: no socket with id " + cId + " — ignoring");
            return;
        }
        try { client.resume(); } catch (Exception e) { Log.w(TAG, "resume error for id " + cId, e); }
    }`
  );
  src = src.replace(
    /public void getPeerCertificate\(final int cId, Promise promise\) \{\s*try \{\s*final TcpSocketClient client = getTcpClient\(cId\);\s*promise\.resolve\(client\.getPeerCertificate\(\)\);\s*\} catch \(Exception e\) \{\s*promise\.reject\(e\);\s*\}\s*\}/,
    `public void getPeerCertificate(final int cId, Promise promise) {
        try {
            final TcpSocketClient client = getTcpClient(cId);
            if (client == null) {
                promise.reject(new Exception("No socket with id " + cId));
                return;
            }
            promise.resolve(client.getPeerCertificate());
        } catch (Exception e) {
            promise.reject(e);
        }
    }`
  );
  src = src.replace(
    /public void getCertificate\(final int cId, Promise promise\) \{\s*try \{\s*final TcpSocketClient client = getTcpClient\(cId\);\s*promise\.resolve\(client\.getCertificate\(\)\);\s*\} catch \(Exception e\) \{\s*promise\.reject\(e\);\s*\}\s*\}/,
    `public void getCertificate(final int cId, Promise promise) {
        try {
            final TcpSocketClient client = getTcpClient(cId);
            if (client == null) {
                promise.reject(new Exception("No socket with id " + cId));
                return;
            }
            promise.resolve(client.getCertificate());
        } catch (Exception e) {
            promise.reject(e);
        }
    }`
  );
  src = src.replace(
    /(\s+)TcpSocketClient client = new TcpSocketClient\(tcpEvtListener, cId, null\);\s+socketMap\.put\(cId, client\);\s+ReadableMap tlsOptions = pendingTLS\.get\(cId\);\s+client\.connect\(mReactContext, host, port, options, currentNetwork\.getNetwork\(\), tlsOptions\);\s+tcpEvtListener\.onConnect\(cId, client\);\s+\} catch \(Exception e\) \{\s+tcpEvtListener\.onError\(cId, e\);\s+\}/,
    `$1TcpSocketClient client = new TcpSocketClient(tcpEvtListener, cId, null);
                    socketMap.put(cId, client);
                    ReadableMap tlsOptions = pendingTLS.get(cId);
                    client.connect(mReactContext, host, port, options, currentNetwork.getNetwork(), tlsOptions);
                    tcpEvtListener.onConnect(cId, client);
                } catch (Exception e) {
                    try { socketMap.remove(cId); } catch (Exception ignored) {}
                    try { pendingTLS.remove(cId); } catch (Exception ignored) {}
                    tcpEvtListener.onError(cId, e);
                }`
  );
  if (src !== orig) {
    fs.writeFileSync(javaPath, src, "utf8");
    return true;
  }
  return false;
}

let patchedCount = 0;
try {
  const out = execSync(`find "${ROOT}" -name "TcpSocketModule.java" 2>/dev/null`, { encoding: "utf8" });
  for (const p of out.split("\n").map(s => s.trim()).filter(Boolean)) {
    if (patchJavaFile(p)) {
      console.log(`[patch-tcp-socket] patched ${p}`);
      patchedCount++;
    }
  }
} catch {}

if (patchedCount === 0) {
  console.log("[patch-tcp-socket] no unpatched TcpSocketModule.java found (already patched or not installed)");
} else {
  console.log(`[patch-tcp-socket] patched ${patchedCount} file(s)`);
}
