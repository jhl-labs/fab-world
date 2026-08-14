import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const contentSecurityPolicy = "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' https: ws: wss:; worker-src 'self' blob:"
const developmentContentSecurityPolicy = contentSecurityPolicy.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
const securityHeaders = (csp: string) => ({
  'Content-Security-Policy': csp,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
})

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'fabworld-production-csp',
      apply: 'build',
      transformIndexHtml: {
        order: 'pre',
        handler: () => [{
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy },
          injectTo: 'head-prepend'
        }]
      }
    }
  ],
  build: {
    // Three.js is an intentionally isolated, cacheable vendor chunk. Keep a
    // narrow ceiling above its current size so growth in any chunk stays noisy.
    chunkSizeWarningLimit: 550,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 20 }
          ]
        }
      }
    }
  },
  worker: { format: 'es' },
  // The demo is commonly viewed from another device on the same lab network.
  // Vite still applies its Host allowlist; do not expose this dev server to an
  // untrusted/public network.
  server: { host: '0.0.0.0', headers: securityHeaders(developmentContentSecurityPolicy) },
  preview: { headers: securityHeaders(contentSecurityPolicy) }
})
