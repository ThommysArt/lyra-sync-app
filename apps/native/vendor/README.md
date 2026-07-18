# Native vendor stubs

## `zxing-wasm-stub`

`expo-camera` pulls `barcode-detector` → `zxing-wasm` (~13 MB WASM) for **web** barcode polyfill.

Lyra’s live QR pairing only needs the **native** CameraView barcode path (ML Kit / Vision). The monorepo root `pnpm.overrides` maps `zxing-wasm` to this stub so installs stay small and offline-friendly.

If you need real web-in-browser QR decoding later, remove the override and install the real `zxing-wasm` package.
