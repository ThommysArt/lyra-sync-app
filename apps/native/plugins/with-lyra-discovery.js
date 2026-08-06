/**
 * Config plugin: inject Android multicast discovery (LocalSend-style).
 * Mirrors packages/net/src/node/discovery.ts but for Android via MulticastSocket.
 * Joins 224.0.0.167 on each interface, sends announce burst, listens for peers.
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

const KOTLIN_MODULE = `package expo.modules.lyradiscovery

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.InetSocketAddress
import kotlin.concurrent.thread

class LyraDiscoveryModule : Module() {
  private var socket: MulticastSocket? = null
  private var running = false
  private var listenThread: Thread? = null
  private val group = "224.0.0.167"
  private val defaultPort = 53318

  override fun definition() = ModuleDefinition {
    Name("LyraDiscovery")

    Events("onPeerAnnounce")

    AsyncFunction("start") { port: Int? ->
      val p = port ?: defaultPort
      if (running) return@AsyncFunction true
      try {
        val s = MulticastSocket(p)
        s.reuseAddress = true
        s.timeToLive = 1
        s.loopbackMode = false
        // Join on each up interface (LocalSend pattern: per-interface membership)
        val groupAddr = InetAddress.getByName(group)
        val ifaces = NetworkInterface.getNetworkInterfaces()
        var joined = 0
        while (ifaces.hasMoreElements()) {
          val ni = ifaces.nextElement()
          if (!ni.isUp || ni.isLoopback) continue
          try {
            s.joinGroup(InetSocketAddress(groupAddr, p), ni)
            joined++
          } catch (_: Exception) {
            try { s.joinGroup(groupAddr) } catch (_: Exception) {}
          }
        }
        if (joined == 0) {
          try { s.joinGroup(groupAddr) } catch (_: Exception) {}
        }
        socket = s
        running = true
        listenThread = thread(isDaemon = true, name = "lyra-discovery-listen") {
          val buf = ByteArray(8192)
          while (running) {
            try {
              val pkt = DatagramPacket(buf, buf.size)
              s.soTimeout = 2000
              s.receive(pkt)
              val json = String(pkt.data, 0, pkt.length, Charsets.UTF_8)
              val remote = pkt.address?.hostAddress ?: ""
              // Forward raw JSON + remoteAddress to JS for Zod validation
              sendEvent("onPeerAnnounce", mapOf("json" to json, "remoteAddress" to remote))
            } catch (e: java.net.SocketTimeoutException) {
              // loop
            } catch (e: Exception) {
              if (!running) break
            }
          }
        }
        return@AsyncFunction true
      } catch (e: Exception) {
        return@AsyncFunction false
      }
    }

    AsyncFunction("announce") { json: String, port: Int? ->
      val p = port ?: defaultPort
      val s = socket
      if (s == null || !running) return@AsyncFunction false
      try {
        val groupAddr = InetAddress.getByName(group)
        val data = json.toByteArray(Charsets.UTF_8)
        // Send on each interface (setNetworkInterface)
        val ifaces = NetworkInterface.getNetworkInterfaces()
        var sent = 0
        while (ifaces.hasMoreElements()) {
          val ni = ifaces.nextElement()
          if (!ni.isUp || ni.isLoopback) continue
          try {
            s.networkInterface = ni
            val pkt = DatagramPacket(data, data.size, groupAddr, p)
            s.send(pkt)
            sent++
          } catch (_: Exception) {}
        }
        if (sent == 0) {
          val pkt = DatagramPacket(data, data.size, groupAddr, p)
          s.send(pkt)
        }
        return@AsyncFunction true
      } catch (e: Exception) {
        return@AsyncFunction false
      }
    }

    AsyncFunction("stop") {
      running = false
      try { socket?.leaveGroup(InetAddress.getByName(group)) } catch (_: Exception) {}
      try { socket?.close() } catch (_: Exception) {}
      socket = null
      listenThread?.interrupt()
      listenThread = null
      return@AsyncFunction true
    }
  }
}
`;

function withLyraDiscovery(config) {
  return withDangerousMod(config, ["android", async (cfg) => {
    const projectRoot = cfg.modRequest.platformProjectRoot;
    const dir = path.join(projectRoot, "app/src/main/java/expo/modules/lyradiscovery");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "LyraDiscoveryModule.kt"), KOTLIN_MODULE, "utf8");
    return cfg;
  }]);
}

module.exports = createRunOncePlugin(withLyraDiscovery, "with-lyra-discovery", "1.0.0");
