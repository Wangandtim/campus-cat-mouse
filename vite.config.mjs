import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    {
      name: 'campus-preview-api',
      async configureServer(server) {
        const { createPreviewApi } = await import('./server/api.mjs');
        const env = { ...loadEnv(mode, process.cwd(), 'AMAP_'), ...process.env };
        const api = createPreviewApi(env);
        server.middlewares.use((req, res, next) => {
          if (/^\/(api|_AMapService)(?:\/|$)/.test(req.url)) {
            void api(req, res);
          } else {
            next();
          }
        });
      },
    },
  ],
}));
