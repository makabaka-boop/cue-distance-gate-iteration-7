import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API is reached same-origin at /api: the dev server proxies to a
// locally running API, and the production nginx container proxies to the
// "server" compose service.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  preview: {
    port: 4173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
