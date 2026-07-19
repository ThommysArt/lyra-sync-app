/**
 * Expo config plugin: Android Accessibility Service scaffold for clipboard monitoring.
 *
 * Spec §5.3: Automatic clipboard monitoring on Android requires an Accessibility Service.
 * This plugin injects:
 *   - AndroidManifest service + meta-data
 *   - res/xml/lyra_clipboard_accessibility.xml
 *   - Kotlin stub ClipboardAccessibilityService (no-op events — safe to compile)
 *
 * Real clipboard extraction is still a follow-up; expo-clipboard remains the default path.
 */
const fs = require("node:fs");
const path = require("node:path");

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
  createRunOncePlugin,
} = configPlugins;

const PACKAGE = "app.lyra.sync";
const SERVICE_FQCN = `${PACKAGE}.clipboard.ClipboardAccessibilityService`;

const ACCESSIBILITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeViewTextChanged|typeWindowContentChanged"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagDefault|flagIncludeNotImportantViews"
    android:canRetrieveWindowContent="false"
    android:description="@string/lyra_clipboard_accessibility_description"
    android:notificationTimeout="200"
    android:settingsActivity="" />
`;

const SERVICE_KT = `package app.lyra.sync.clipboard

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

/**
 * Scaffold AccessibilityService for future clipboard monitoring (product spec §5.3).
 * Currently a no-op so release/EAS builds compile after prebuild.
 * Real extraction should validate package context and never capture passwords.
 */
class ClipboardAccessibilityService : AccessibilityService() {
  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // Intentionally empty — wire clipboard monitoring in a follow-up.
  }

  override fun onInterrupt() {
    // no-op
  }
}
`;

/**
 * @param {import('@expo/config-plugins').ExportedConfig} config
 */
function withClipboardAccessibilityManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    if (!app.service) app.service = [];
    const exists = app.service.some(
      (s) =>
        s.$?.["android:name"] === SERVICE_FQCN ||
        s.$?.["android:name"] === ".clipboard.ClipboardAccessibilityService",
    );
    if (!exists) {
      app.service.push({
        $: {
          "android:name": SERVICE_FQCN,
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

/**
 * Write XML resource + Kotlin stub during prebuild.
 * @param {import('@expo/config-plugins').ExportedConfig} config
 */
function withClipboardAccessibilityFiles(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const projectRoot = cfg.modRequest.platformProjectRoot;
      const xmlDir = path.join(projectRoot, "app/src/main/res/xml");
      const valuesDir = path.join(projectRoot, "app/src/main/res/values");
      const kotlinDir = path.join(
        projectRoot,
        "app/src/main/java/app/lyra/sync/clipboard",
      );

      fs.mkdirSync(xmlDir, { recursive: true });
      fs.mkdirSync(valuesDir, { recursive: true });
      fs.mkdirSync(kotlinDir, { recursive: true });

      fs.writeFileSync(
        path.join(xmlDir, "lyra_clipboard_accessibility.xml"),
        ACCESSIBILITY_XML,
        "utf8",
      );

      const stringsPath = path.join(valuesDir, "strings.xml");
      let strings = fs.existsSync(stringsPath)
        ? fs.readFileSync(stringsPath, "utf8")
        : `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n`;
      if (!strings.includes("lyra_clipboard_accessibility_description")) {
        strings = strings.replace(
          "</resources>",
          `  <string name="lyra_clipboard_accessibility_description">Allows Lyra to detect clipboard changes for local multi-device sync. Data never leaves your devices.</string>\n</resources>`,
        );
        fs.writeFileSync(stringsPath, strings, "utf8");
      }

      fs.writeFileSync(
        path.join(kotlinDir, "ClipboardAccessibilityService.kt"),
        SERVICE_KT,
        "utf8",
      );

      return cfg;
    },
  ]);
}

function withClipboardAccessibility(config) {
  config = withClipboardAccessibilityManifest(config);
  config = withClipboardAccessibilityFiles(config);
  return config;
}

module.exports = createRunOncePlugin(
  withClipboardAccessibility,
  "with-lyra-clipboard-accessibility",
  "1.1.0",
);
