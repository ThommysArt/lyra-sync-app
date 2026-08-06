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
          if (!ni.isUp || ni.isLoopback) continue
          val addrs = ni.interfaceAddresses
          for (ia in addrs) {
            val addr = ia.address
            if (addr is Inet4Address && !addr.isLoopbackAddress) {
              val host = addr.hostAddress ?: continue
              if (host == "127.0.0.1" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.") || host.startsWith("100.")) {
                val parts = host.split(".")
                if (parts.size == 4) out.add(host)
              } else if (host.contains(".")) {
                out.add(host)
              }
            }
          }
          // Fallback: inetAddresses if interfaceAddresses empty (some OEM)
          if (out.isEmpty()) {
            val addrs2 = ni.inetAddresses
            while (addrs2.hasMoreElements()) {
              val addr = addrs2.nextElement()
              if (addr is Inet4Address && !addr.isLoopbackAddress) {
                val host = addr.hostAddress ?: continue
                if (host.contains(".")) out.add(host)
              }
            }
          }
        }
      } catch (e: Exception) {}
      return@AsyncFunction out.distinct()
    }

    AsyncFunction("listLanHostsDetailed") {
      val out = mutableListOf<Map<String, Any>>()
      try {
        val interfaces = NetworkInterface.getNetworkInterfaces()
        while (interfaces.hasMoreElements()) {
          val ni = interfaces.nextElement()
          if (!ni.isUp || ni.isLoopback) continue
          for (ia in ni.interfaceAddresses) {
            val addr = ia.address
            if (addr is Inet4Address && !addr.isLoopbackAddress) {
              val host = addr.hostAddress ?: continue
              val prefix = ia.networkPrefixLength
              out.add(mapOf("host" to host, "prefixLength" to prefix.toInt(), "iface" to ni.name))
            }
          }
        }
      } catch (e: Exception) {}
      return@AsyncFunction out
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

module.exports = createRunOncePlugin(withLyraNetwork, "with-lyra-network", "1.1.0");
