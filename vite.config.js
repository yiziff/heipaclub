import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  server: {
    port: 5173,
    open: true,
    // /api/* 由 cf-api Worker + run_worker_first 处理（见 wrangler.jsonc）
    // 本地需：.dev.vars 里 NETEASE_API_ORIGIN + npm run db:init:local
    // 下面 proxy 仅作无 Worker 时的兜底，正常开发可忽略
    proxy: {
      "/api/netease": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/netease/, ""),
      },
      "/api/rank": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
      "/api/itunes": {
        target: "https://itunes.apple.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/itunes/, ""),
      },
    },
  },
});
