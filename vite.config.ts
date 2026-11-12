import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    target: "safari15",
    chunkSizeWarningLimit: 2000,
    // The notch is its own small page: no terminal or editor code in it.
    rollupOptions: { input: { main: "index.html", notch: "notch.html" } },
  },
});
