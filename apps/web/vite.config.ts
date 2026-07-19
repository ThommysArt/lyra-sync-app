import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative asset URLs so packaged Electron loadFile() works (file:// protocol).
  // Absolute "/assets/..." breaks under AppImage/asar resources.
  base: "./",
  server: {
    port: 3001,
  },
  resolve: {
    tsconfigPaths: true,
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
