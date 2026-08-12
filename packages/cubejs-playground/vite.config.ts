import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: 'build',
    target: 'es2020',
  },
  server: {
    port: 3080,
    proxy: {
      '^/playground/*': 'http://localhost:4000',
      '^/cubejs-api/*': 'http://localhost:4000',
    },
  },
  plugins: [
    react(),
  ],
  resolve: {
    alias: [
      {
        find: /^@ant-design\/icons$/,
        replacement: fileURLToPath(new URL('./src/shared/icons/FontAwesomeIcons.tsx', import.meta.url)),
      },
    ],
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true,
        additionalData: '@root-entry-name: default;',
      },
    },
  },
  define: {
    'process.env.SC_DISABLE_SPEEDY': JSON.stringify('false'),
    ...(mode === 'development' ? { global: {} } : {}),
  },
}));
