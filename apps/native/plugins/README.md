# Native Expo config plugins

## with-clipboard-accessibility

Scaffolds Android Accessibility Service support for product-spec §5.3 clipboard auto-monitor.

### What it generates (during `expo prebuild` / EAS)

1. AndroidManifest service + `BIND_ACCESSIBILITY_SERVICE`
2. `res/xml/lyra_clipboard_accessibility.xml`
3. String description for the system Accessibility UI
4. Kotlin stub `app.lyra.sync.clipboard.ClipboardAccessibilityService` (no-op events)

### Enable

In `app.json` plugins array:

```json
["./plugins/with-clipboard-accessibility"]
```

### Still required (product)

1. Real clipboard extraction in the service (with password field guards)
2. In-app deep-link to system Accessibility settings so the user can enable the service
3. Play Store policy review — Accessibility for clipboard is sensitive

Foreground polling via `expo-clipboard` remains the default path used by `ClipboardMonitor`.
