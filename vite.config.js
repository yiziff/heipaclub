import { defineConfig } from "vite";

export default defineConfig({
  plugins: [],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // song-vocab-agent 同款：本机 api-enhanced
      "/api/netease": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/netease/, ""),
      },
      // anonymous rank API (npm run rank:dev)
      "/api/rank": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});
