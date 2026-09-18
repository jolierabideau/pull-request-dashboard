import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Follows the API rather than assuming 5174, so that the advice printed when
// 5174 is taken (`PORT=5175 npm run dev`) actually produces a working board
// instead of one whose every /api request is refused.
const apiPort = Number(process.env.PORT ?? 5174);

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    // Without this Vite quietly moves to the next free port when 5173 is held
    // by a stranded dev server — and the next free port is the API's 5174.
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
