import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from "path"
import { VitePWA } from 'vite-plugin-pwa'
import mkcert from 'vite-plugin-mkcert'
const { version } = require("./package.json")

const projectRoot = __dirname
const useHttps = process.env.PT_DEV_HTTPS !== "0"
const localServer = "http://127.0.0.1:8787"

// https://vitejs.dev/config/
export default defineConfig(() => {
  return {
    plugins: [
      vue(),

      ...(useHttps ? [mkcert()] : []),
      
      VitePWA({
        registerType: "autoUpdate",
        manifest: false,
        devOptions: {
          enabled: true,
          type: 'module'
        },
        includeAssets: [
          "apple-touch-icon.png",
          "apple-touch-icon-180x180.png",
          "favicon-32x32.png", 
          "favicon-16x16.png", 
          "safari-pinned-tab.svg"
        ]
      })
    ],
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      allowedHosts: true,
      proxy: {
        "/room-operate": { target: localServer, changeOrigin: true },
        "/parse-text": { target: localServer, changeOrigin: true },
        "/pt-service": { target: localServer, changeOrigin: true },
        "/health": { target: localServer, changeOrigin: true },
        "/demo": { target: localServer, changeOrigin: true },
        "/ws": { target: "ws://127.0.0.1:8787", ws: true },
      }
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
      proxy: {
        "/room-operate": { target: localServer, changeOrigin: true },
        "/parse-text": { target: localServer, changeOrigin: true },
        "/pt-service": { target: localServer, changeOrigin: true },
        "/health": { target: localServer, changeOrigin: true },
        "/demo": { target: localServer, changeOrigin: true },
        "/ws": { target: "ws://127.0.0.1:8787", ws: true },
      }
    },
    resolve: {
      alias: {
        "@": resolve(projectRoot, "src"),
      }
    },
    define: {
      "PT_ENV": {
        "version": version,
        "client": "web"
      }
    }
  }
})
