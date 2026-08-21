import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/cubejs-api': { target: 'http://localhost:4000', changeOrigin: true, secure: false },
      '/playground': { target: 'http://localhost:4000', changeOrigin: true, secure: false },
    },
  },
});
