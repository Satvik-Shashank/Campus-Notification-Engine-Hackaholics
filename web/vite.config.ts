import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The built SPA is served by the Express app from ../public (single origin, no CORS surface).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: '../public', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(['/events', '/admin', '/inbox', '/webhooks', '/health'].map((p) => [p, 'http://localhost:3000'])),
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
