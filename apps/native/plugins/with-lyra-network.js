/**
 * Config plugin: inject native LyraNetwork module for multi-interface enumeration.
 * Enumerates all non-loopback IPv4 addresses (Wi-Fi + Tailscale) via NetworkInterface,
 * solving single-IP bug where expo-network returns only Tailscale 100.x.
 */
const fs = require("node:fs");
const path = require("node:path");

const configPlugins = (() => {
  try { return require("@expo/config-plugins"); } catch {
    const expoPkg = require.resolve("expo/package.json");
    return require(require.resolve("@expo/config-plugins", { paths: [expoPkg] }));
  }
})();
const { withDangerousMod, createRunOncePlugin } = configPlugins;

const KOTLIN_MODULE = `package expo.modules.lyranetwork

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface

class LyraNetworkModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LyraNetwork")

    AsyncFunction("listLanHosts") {
      val out = mutableListOf<String>()
      try {
        val interfaces = NetworkInterface.getNetworkInterfaces()
        while (interfaces.hasMoreElements()) {
          val ni = interfaces.nextElement()
          // Skip down / loopback / virtual
          if (!ni.isUp || ni.isLoopback) continue
          val addrs = ni.inetAddresses
          while (addrs.hasMoreElements()) {
            val addr = addrs.nextElement()
            if (addr is Inet4Address && !addr.isLoopbackAddress) {
              val host = addr.hostAddress ?: continue
              // Include private LAN + Tailscale CGNAT + loopback 127 for self-test
              if (host == "127.0.0.1" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.") || host.startsWith("100.")) {
                // Validate numeric octets
                val parts = host.split(".")
                if (parts.size == 4) out.add(host)
              } else if (host.contains(".")) {
                // Other IPv4 (fallback)
                out.add(host)
              }
            }
          }
        }
      } catch (e: Exception) {
        // return what we have
      }
      // Dedupe and keep Tailscale last so primary Wi-Fi is first
      return@AsyncFunction out.distinct()
    }
  }
}
`;

function withLyraNetwork(config) {
  return withDangerousMod(config, ["android", async (cfg) => {
    const projectRoot = cfg.modRequest.platformProjectRoot;
    const kotlinDir = path.join(projectRoot, "app/src/main/java/expo/modules/lyranetwork");
    fs.mkdirSync(kotlinDir, { recursive: true });
    fs.writeFileSync(path.join(kotlinDir, "LyraNetworkModule.kt"), KOTLIN_MODULE, "utf8");
    return cfg;
  }]);
}

module.exports = createRunOncePlugin(withLyraNetwork, "with-lyra-network", "1.0.0");
