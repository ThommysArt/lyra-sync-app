/**
 * Expo config plugin scaffold: Android Accessibility Service for clipboard monitoring.
 *
 * Spec §5.3: Automatic clipboard monitoring on Android requires an Accessibility Service.
 * This plugin injects the service declaration + meta-data into AndroidManifest when
 * a native service implementation is present under android/app/.../ClipboardAccessibilityService.
 *
 * Status: scaffold — ships the manifest hooks and documentation path. Full Java/Kotlin
 * service body is intentionally minimal (no-op onAccessibilityEvent) so release builds
 * can compile once `npx expo prebuild` is run. Wire real clipboard extraction in a
 * follow-up native module.
 *
 * Enable by adding to app.json plugins:
 *   ["./plugins/with-clipboard-accessibility"]
 */
// Resolve from expo's dependency tree (not always hoisted to apps/native)
const configPlugins = (() => {
  try {
    return require("@expo/config-plugins");
  } catch {
    const expoPkg = require.resolve("expo/package.json");
    return require(require.resolve("@expo/config-plugins", { paths: [expoPkg] }));
  }
})();
const { withAndroidManifest, AndroidConfig, createRunOncePlugin } = configPlugins;

const PACKAGE = "app.lyra.sync";
const SERVICE_NAME = ".clipboard.ClipboardAccessibilityService";

/**
 * @param {import('@expo/config-plugins').ExportedConfig} config
 */
function withClipboardAccessibility(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    // Ensure BIND_ACCESSIBILITY_SERVICE permission is declared for the service
    if (!manifest.manifest["uses-permission"]) {
      manifest.manifest["uses-permission"] = [];
    }
    const perms = manifest.manifest["uses-permission"];
    const hasBind = perms.some(
      (p) =>
        p.$?.["android:name"] === "android.permission.BIND_ACCESSIBILITY_SERVICE",
    );
    // BIND_ACCESSIBILITY_SERVICE is a service permission, not uses-permission — skip adding invalid uses-permission

    if (!app.service) app.service = [];
    const exists = app.service.some(
      (s) => s.$?.["android:name"] === SERVICE_NAME || s.$?.["android:name"] === `${PACKAGE}.clipboard.ClipboardAccessibilityService`,
    );
    if (!exists) {
      app.service.push({
        $: {
          "android:name": `${PACKAGE}.clipboard.ClipboardAccessibilityService`,
          "android:exported": "false",
          "android:permission": "android.permission.BIND_ACCESSIBILITY_SERVICE",
          "android:label": "Lyra clipboard monitor",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name": "android.accessibilityservice.AccessibilityService",
                },
              },
            ],
          },
        ],
        "meta-data": [
          {
            $: {
              "android:name": "android.accessibilityservice",
              "android:resource": "@xml/lyra_clipboard_accessibility",
            },
          },
        ],
      });
    }

    return cfg;
  });
}

module.exports = createRunOncePlugin(
  withClipboardAccessibility,
  "with-lyra-clipboard-accessibility",
  "1.0.0",
);
