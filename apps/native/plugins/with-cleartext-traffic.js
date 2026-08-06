/**
 * Ensure Android release/debug both allow cleartext HTTP for LAN + Tailscale peers.
 * Expo's `android.usesCleartextTraffic` only reliably lands on debug variants after prebuild;
 * this plugin writes main manifest + network_security_config.xml.
 *
 * Resolve @expo/config-plugins via expo (pnpm does not hoist it to apps/native).
 */
const configPlugins = (() => {
  try {
    return require("@expo/config-plugins");
  } catch {
    const expoPkg = require.resolve("expo/package.json");
    return require(require.resolve("@expo/config-plugins", { paths: [expoPkg] }));
  }
})();
const {
  withAndroidManifest,
  withDangerousMod,
  AndroidConfig,
} = configPlugins;
const fs = require("node:fs");
const path = require("node:path");

const NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Lyra peers speak plain HTTP on LAN / Tailscale (app-level AES-GCM seals after pairing). -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

function withNetworkSecurityConfigFile(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/res/xml",
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, "network_security_config.xml"),
        NETWORK_SECURITY_XML,
        "utf8",
      );
      return cfg;
    },
  ]);
}

function withCleartextManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$ = app.$ ?? {};
    app.$["android:usesCleartextTraffic"] = "true";
    app.$["android:networkSecurityConfig"] = "@xml/network_security_config";
    return cfg;
  });
}

function withCleartextTraffic(config) {
  config = withNetworkSecurityConfigFile(config);
  config = withCleartextManifest(config);
  return config;
}

module.exports = withCleartextTraffic;
