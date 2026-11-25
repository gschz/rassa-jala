import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite-plus";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 3001,
    allowedHosts: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    varlockVitePlugin({ ssrInjectMode: "auto-load" }),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        // Precache the app shell only (index + JS/CSS + brand icons). Server
        // data (API on :3000, /storage images) is NOT precached: offline data
        // is RxDB's job (IndexedDB), the service worker only makes cold start
        // possible without a server.
        globPatterns: ["**/*.{js,css,html,png,svg,ico,webmanifest}"],
        navigateFallback: "/index.html",
      },
      manifest: {
        name: "RassaJala",
        short_name: "RassaJala",
        description:
          "Red Agroecológica y Solidaria para la Soberanía Alimentaria — pedidos, catálogos y sincronización offline.",
        lang: "es-MX",
        dir: "ltr",
        theme_color: "#1F4D36",
        background_color: "#111B15",
        display: "standalone",
        start_url: "/",
        scope: "/",
        id: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icon-maskable-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        screenshots: [
          {
            src: "/screenshots/catalogo-desktop-wide.png",
            sizes: "1280x720",
            type: "image/png",
            form_factor: "wide",
          },
          {
            src: "/screenshots/catalogo-mobile.png",
            sizes: "390x844",
            type: "image/png",
            form_factor: "narrow",
          },
        ],
      },
      devOptions: { enabled: true },
    }),
  ],
});
