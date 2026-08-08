import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative asset URLs so packaged Electron loadFile() works (file:// protocol).
  // Absolute "/assets/..." breaks under AppImage/asar resources.
  base: "./",
  optimizeDeps: {
    exclude: ["undici", "expo-file-system", "expo-file-system/legacy", "react-native-tcp-socket", "expo-modules-core", "expo-constants", "expo-network", "react-native"],
  },
  ssr: {
    external: ["undici", "expo-file-system", "expo-file-system/legacy", "react-native-tcp-socket", "expo-modules-core", "expo-constants", "expo-network", "react-native", "node:net", "node:dgram", "node:os", "node:fs", "node:child_process"],
    noExternal: [],
  },
  build: {
    rolldownOptions: {
      external: [
        "expo-file-system",
        "expo-file-system/legacy",
        "react-native-tcp-socket",
        "expo-modules-core",
        "expo-constants",
        "expo-network",
        "react-native",
        "node:net",
        "node:dgram",
        "node:os",
        "node:fs",
        "node:child_process",
      ],
    },
  },
  server: {
    // Listen on 0.0.0.0 so LAN / Tailscale can reach the UI (same as `vite --host`).
    host: true,
    port: 3001,
  },
  preview: {
    host: true,
    port: 3001,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    {
      name: "ignore-native-imports",
      // For web/Electron, native modules are not available — stub them out in dev and build
      resolveId(id) {
        if (
          id === "expo-file-system" ||
          id === "expo-file-system/legacy" ||
          id === "react-native-tcp-socket" ||
          id === "expo-modules-core" ||
          id === "expo-constants" ||
          id === "expo-network" ||
          id === "react-native"
        ) {
          return "\0virtual:empty-native";
        }
        if (id.startsWith("node:")) return "\0virtual:empty-native";
        return null;
      },
      load(id) {
        if (id === "\0virtual:empty-native") {
          return "export default {}; export const File = class {}; export const Directory = class {}; export const Paths = { cache: { uri: '' } }; export const createSocket = () => null; export const Socket = class {};";
        }
        return null;
      },
    },
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Lyra",
        short_name: "Lyra",
        description: "Privacy-first device network — clipboard, files, and remote browse.",
        theme_color: "#2F6BFF",
        background_color: "#0B0F17",
      },
      pwaAssets: { disabled: false, config: true },
      // Disable SW registration in dev to avoid noisy console + HMR races
      devOptions: { enabled: false },
    }),
  ],
});
