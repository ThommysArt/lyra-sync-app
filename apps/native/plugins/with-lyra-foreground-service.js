/**
 * Config plugin: foreground service for keeping peer server + mDNS alive in background.
 * Persistent notification "Lyra is reachable on LAN" — user accepted trade-off.
 */
const fs = require("node:fs");
const path = require("node:path");

const configPlugins = (() => {
  try { return require("@expo/config-plugins"); } catch {
    const expoPkg = require.resolve("expo/package.json");
    return require(require.resolve("@expo/config-plugins", { paths: [expoPkg] }));
  }
})();
const { withAndroidManifest, withDangerousMod, AndroidConfig, createRunOncePlugin } = configPlugins;

const SERVICE_KT = (packageId) => `package ${packageId}.foreground

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder

class LyraForegroundService : Service() {
    private var wifiLock: WifiManager.WifiLock? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        // Acquire locks
        try {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Lyra:WifiLock")
            wifiLock?.setReferenceCounted(false)
            wifiLock?.acquire()
            multicastLock = wifi.createMulticastLock("Lyra:MulticastLock")
            multicastLock?.setReferenceCounted(false)
            multicastLock?.acquire()
        } catch (_: Exception) {}
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(1, notification)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        try { wifiLock?.release() } catch (_: Exception) {}
        try { multicastLock?.release() } catch (_: Exception) {}
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            val ch = NotificationChannel("lyra-foreground", "Lyra network", NotificationManager.IMPORTANCE_LOW)
            ch.description = "Keeps Lyra reachable for pairing and file transfers"
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, "lyra-foreground")
        } else {
            Notification.Builder(this)
        }
        builder.setContentTitle("Lyra is reachable")
            .setContentText("Listening for pairing, clipboard and files on LAN/Tailscale")
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setContentIntent(launch)
        return builder.build()
    }
}
`;

const MODULE_KT = `package expo.modules.lyraforeground

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LyraForegroundModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LyraForeground")
    AsyncFunction("start") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      val intent = Intent(ctx, Class.forName("\${ctx.packageName}.foreground.LyraForegroundService"))
      try {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
          ctx.startForegroundService(intent)
        } else {
          ctx.startService(intent)
        }
        return@AsyncFunction true
      } catch (e: Exception) { return@AsyncFunction false }
    }
    AsyncFunction("stop") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      val intent = Intent(ctx, Class.forName("\${ctx.packageName}.foreground.LyraForegroundService"))
      return@AsyncFunction try { ctx.stopService(intent); true } catch (e: Exception) { false }
    }
  }
}
`;

function resolvePackage(config) { return config.android?.package || "app.lyra.sync"; }

function withForegroundManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    // permissions
    const perm = manifest.manifest?.["uses-permission"] ?? [];
    const hasFg = perm.some((p) => p.$?.["android:name"] === "android.permission.FOREGROUND_SERVICE");
    if (!hasFg) {
      manifest.manifest["uses-permission"] = [...(perm || []), { $: { "android:name": "android.permission.FOREGROUND_SERVICE" } }];
    }
    const hasFgDataSync = perm.some((p) => p.$?.["android:name"] === "android.permission.FOREGROUND_SERVICE_DATA_SYNC");
    if (!hasFgDataSync) {
      manifest.manifest["uses-permission"] = [...(manifest.manifest["uses-permission"] || []), { $: { "android:name": "android.permission.FOREGROUND_SERVICE_DATA_SYNC" } }];
    }
    const hasPost = perm.some((p) => p.$?.["android:name"] === "android.permission.POST_NOTIFICATIONS");
    if (!hasPost) {
      manifest.manifest["uses-permission"] = [...(manifest.manifest["uses-permission"] || []), { $: { "android:name": "android.permission.POST_NOTIFICATIONS" } }];
    }
    const hasWifi = perm.some((p) => p.$?.["android:name"] === "android.permission.WAKE_LOCK");
    if (!hasWifi) {
      manifest.manifest["uses-permission"] = [...(manifest.manifest["uses-permission"] || []), { $: { "android:name": "android.permission.WAKE_LOCK" } }];
    }

    const packageId = resolvePackage(cfg);
    const svcName = packageId + ".foreground.LyraForegroundService";
    if (!app.service) app.service = [];
    const exists = app.service.some((s) => String(s.$?.["android:name"] || "").endsWith("LyraForegroundService"));
    if (!exists) {
      app.service.push({
        $: {
          "android:name": svcName,
          "android:exported": "false",
          "android:foregroundServiceType": "dataSync",
        },
      });
    }
    return cfg;
  });
}

function withForegroundFiles(config) {
  return withDangerousMod(config, ["android", async (cfg) => {
    const packageId = resolvePackage(cfg);
    const packagePath = packageId.replace(/\./g, "/");
    const projectRoot = cfg.modRequest.platformProjectRoot;
    const svcDir = path.join(projectRoot, "app/src/main/java", packagePath, "foreground");
    const modDir = path.join(projectRoot, "app/src/main/java/expo/modules/lyraforeground");
    fs.mkdirSync(svcDir, { recursive: true });
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(svcDir, "LyraForegroundService.kt"), SERVICE_KT(packageId), "utf8");
    // Fix module template placeholder
    let modSrc = MODULE_KT.replace("\${ctx.packageName}", packageId);
    // Actually we need proper string: the module uses ctx.packageName dynamically, not static
    // So revert placeholder -> use ctx.packageName directly
    modSrc = `package expo.modules.lyraforeground

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LyraForegroundModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LyraForeground")
    AsyncFunction("start") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      val intent = Intent(ctx, Class.forName(ctx.packageName + ".foreground.LyraForegroundService"))
      return@AsyncFunction try {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) ctx.startForegroundService(intent) else ctx.startService(intent)
        true
      } catch (e: Exception) { false }
    }
    AsyncFunction("stop") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      val intent = Intent(ctx, Class.forName(ctx.packageName + ".foreground.LyraForegroundService"))
      return@AsyncFunction try { ctx.stopService(intent); true } catch (e: Exception) { false }
    }
  }
}
`;
    fs.writeFileSync(path.join(modDir, "LyraForegroundModule.kt"), modSrc, "utf8");
    return cfg;
  }]);
}

function withLyraForeground(config) {
  config = withForegroundManifest(config);
  config = withForegroundFiles(config);
  return config;
}

module.exports = createRunOncePlugin(withLyraForeground, "with-lyra-foreground-service", "1.0.0");
