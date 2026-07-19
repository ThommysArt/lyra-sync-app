# Native Expo config plugins

## with-clipboard-accessibility

Scaffolds Android Accessibility Service **manifest entries** for product-spec §5.3 clipboard auto-monitor.

### Enable

In `app.json` plugins array:

```json
["./plugins/with-clipboard-accessibility"]
```

Then:

```bash
npx expo prebuild --platform android
```

### Still required (native)

1. Kotlin/Java class `app.lyra.sync.clipboard.ClipboardAccessibilityService`
2. Resource `res/xml/lyra_clipboard_accessibility.xml` (event types, feedback, description)
3. In-app deep-link to system Accessibility settings so the user can enable the service
4. Play Store policy review — Accessibility for clipboard is sensitive

Foreground polling via `expo-clipboard` remains the default path used by `ClipboardMonitor`.
