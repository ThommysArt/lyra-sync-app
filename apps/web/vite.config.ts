import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@lyra-sync-app/hooks": path.resolve(__dirname, "../../packages/hooks/src"),
      "@lyra-sync-app/core": path.resolve(__dirname, "../../packages/core/src"),
      "@lyra-sync-app/transport": path.resolve(__dirname, "../../packages/transport/src"),
      "@lyra-sync-app/protocol": path.resolve(__dirname, "../../packages/protocol/src"),
      "@lyra-sync-app/discovery": path.resolve(__dirname, "../../packages/discovery/src"),
      "@lyra-sync-app/daemon": path.resolve(__dirname, "../../packages/daemon/src"),
    },
  },
  build: {
    rolldownOptions: {
      external: ["react-native-tcp-socket", "@react-native-async-storage/async-storage"],
    },
  },
  optimizeDeps: {
    exclude: ["react-native-tcp-socket", "@react-native-async-storage/async-storage"],
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "lyra-sync-app",
        short_name: "lyra-sync-app",
        description: "lyra-sync-app - PWA Application",
        theme_color: "#0c0c0c",
      },
      pwaAssets: { disabled: false, config: true },
      devOptions: { enabled: true },
    }),
  ],
});
