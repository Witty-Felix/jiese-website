import { onRequestPost as preparePost } from '../functions/api/prepare.js';

const originalFetch = globalThis.fetch;
try {
  for (const upstreamStatus of [200, 401]) {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(new URL(url).pathname);
      return {
        status: upstreamStatus,
        json: async () => ({ code: 200002, msg: 'skill auth failed', data: {} }),
      };
    };
    const env = {
      INVITE_CODE: 'test-code', IMA_KB_ID: 'kb_test',
      IMA_OPENAPI_CLIENTID: 'test-client', IMA_OPENAPI_APIKEY: 'expired-test-key',
      // prepare 现在会先落一条幂等记录（ADR-0009），KV 绑定必须在场；
      // 否则会先撞上 submission_write 的 503，测不到凭据失效这条路径
      STATS: {
        _map: new Map(),
        async get(k) { return this._map.get(k) ?? null; },
        async put(k, v) { this._map.set(k, String(v)); },
      },
    };
    const request = new Request('https://site.test/api/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nickname: 'test-user', invite_code: 'test-code',
        image: { type: 'image/png', size: 1024 },
        audio: { type: 'audio/mp4', size: 2048 },
      }),
    });
    const response = await preparePost({ request, env });
    const body = await response.json();
    if (response.status !== 503 || body.stage !== 'ima_auth' || body.retryable !== false ||
        !body.error.includes('Pages Secret') || body.error.includes('skill auth failed') ||
        calls.length !== 2 || !calls.every((path) => path.endsWith('/create_media'))) {
      throw new Error(`credential failure contract violated: ${JSON.stringify({ status: response.status, body, calls })}`);
    }
    console.log(`✓ ima 200002 (HTTP ${upstreamStatus}): actionable non-retryable 503 without raw upstream text`);
  }
} finally {
  globalThis.fetch = originalFetch;
}
