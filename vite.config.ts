import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    target: "safari15",
    chunkSizeWarningLimit: 2000,
    // The notch and the phone page are their own small pages: no terminal or editor code in them.
    rollupOptions: { input: { main: "index.html", notch: "notch.html", remote: "remote.html" } },
  },
});
