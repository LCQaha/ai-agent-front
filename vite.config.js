import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
    // 只用于开发服务器转发，不会将这个配置或任何模型密钥打包给浏览器。
    const env = loadEnv(mode, process.cwd(), '');
    const target = process.env.BACKEND_URL || env.BACKEND_URL || 'http://localhost:8090';
    const upstream = { target, changeOrigin: true };
    const apiProxy = { ...upstream, rewrite: path => path.replace(/^\/api\/?/, '/') };
    const docsProxy = {
        '/v3/api-docs': upstream,
        '/swagger-ui': upstream,
        '/webjars': upstream,
    };
    return {
        plugins: [vue()],
        server: {
            host: 'localhost',
            port: 5174,
            strictPort: true,
            proxy: {
                ...docsProxy,
                '^/api(?:/|\\?|$)': apiProxy,
            },
        },
        preview: {
            host: 'localhost', port: 4173, strictPort: true,
            proxy: { ...docsProxy, '/api/ai/first-app': apiProxy, '^/api/ai/benchmark(?:-stream|-event-stream)?(?:\\?|$)': apiProxy, '/api': upstream },
        },
        test: { environment: 'jsdom', clearMocks: true, restoreMocks: true }
    };
});
