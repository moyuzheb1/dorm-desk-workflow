import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';

const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';

function json(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void },
  status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/**
 * OpenRouter 只从服务端转发。API key 永不进入浏览器包：
 * 前端一律请求 /api/llm，key 由环境变量或 .env.local 提供。
 */
function openrouterProxy(key: string | undefined, model: string): Plugin {
  return {
    name: 'openrouter-proxy',
    configureServer(server) {
      server.middlewares.use('/api/status', (_req, res) => {
        json(res, 200, { configured: !!key, model });
      });

      server.middlewares.use('/api/llm', (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
          return;
        }
        if (!key) {
          json(res, 503, { error: 'NO_API_KEY', message: '未配置 OPENROUTER_API_KEY，前端应降级到离线算子' });
          return;
        }

        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body) as { messages?: unknown };
            const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:5173',
                'X-Title': 'dorm-desk-workflow',
              },
              body: JSON.stringify({
                model,
                messages: payload.messages ?? [],
                response_format: { type: 'json_object' },
                temperature: 0.2,
                max_tokens: 1200,
              }),
            });
            const text = await upstream.text();
            res.statusCode = upstream.status;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(text);
          } catch (e) {
            json(res, 502, { error: 'UPSTREAM_FAILED', message: String(e) });
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const key = env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  const model = env.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  return { plugins: [openrouterProxy(key, model)] };
});
