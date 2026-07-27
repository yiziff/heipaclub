import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // 本地开发：本机 api-enhanced
      "/api/netease": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/netease/, ""),
      },
      // 本地开发：npm run rank:dev
      "/api/rank": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});
