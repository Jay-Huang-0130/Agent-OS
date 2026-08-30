import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 4173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } },
  },
  preview: { host: true, port: 4173 },
  build: { target: "es2022", sourcemap: true },
});
