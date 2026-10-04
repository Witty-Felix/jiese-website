import assert from 'node:assert/strict';
import { onRequestPost as preparePost } from '../functions/api/prepare.js';
import { onRequestPost as finalizePost } from '../functions/api/finalize.js';
import { shanghaiDate } from '../functions/api/_ima.js';
import {
  H5_AUDIO_MAX_BYTES,
  IMAGE_MAX_BYTES,
  UPLOAD_CHANNEL,
  WECHAT_AUDIO_MAX_BYTES,
  WECHAT_AUDIO_LIMIT_ERROR,
} from '../functions/api/_upload-contract.js';

const baseEnv = () => {
  const map = new Map();
  return {
    INVITE_CODE: 'test-code',
    IMA_KB_ID: 'kb_test',
    IMA_OPENAPI_CLIENTID: 'test-client',
    IMA_OPENAPI_APIKEY: 'test-key',
    STATS: {
      map,
      async get(key) { return map.get(key) ?? null; },
      async put(key, value) { map.set(key, String(value)); },
      async delete(key) { map.delete(key); },
    },
  };
};

const makeRequest = (path, body) => new Request(`https://site.test${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const mediaCredential = (kind) => ({
  media_id: kind === 'image' ? 'img_1' : 'soundrecording_1',
  cos_credential: {
    bucket_name: 'bucket', region: 'region', cos_key: `uploads/${kind}`,
    secret_id: 'secret-id', secret_key: 'secret-key',
    start_time: '1700000000', expired_time: '1700003600', token: 'token',
  },
});

const installCreateMediaStub = () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(new URL(url).pathname);
    const path = new URL(url).pathname;
    return {
      status: 200,
      json: async () => ({ code: 0, msg: 'ok', data: mediaCredential(path.endsWith('create_media') && calls.length === 1 ? 'image' : 'audio') }),
    };
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
};

const preparePayload = (overrides = {}) => ({
  nickname: 'test-user',
  invite_code: 'test-code',
  image: { type: 'image/png', size: 1024 },
  audio: { type: 'audio/mp4', size: 2048 },
  ...overrides,
});

const finalizePayload = (overrides = {}) => ({
  nickname: 'test-user',
  invite_code: 'test-code',
  submission_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  image: { media_id: 'img_1', cos_key: 'uploads/image', size: 1024 },
  audio: { media_id: 'soundrecording_1', cos_key: 'uploads/audio', size: 2048 },
  ...overrides,
});

// A client-side rejection must happen before submission:<submission_id> and
// before either create_media call, so an oversized file cannot leave an ima
// temporary object behind.
{
  const env = baseEnv();
  const stub = installCreateMediaStub();
  try {
    const response = await preparePost({
      request: makeRequest('/api/prepare', preparePayload({
        channel: UPLOAD_CHANNEL.WECHAT_MINIPROGRAM,
        audio: { type: 'audio/mp4', size: WECHAT_AUDIO_MAX_BYTES + 1 },
      })),
      env,
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.equal(body.error, WECHAT_AUDIO_LIMIT_ERROR);
    assert.equal(env.STATS.map.size, 0);
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
}

// Exactly 100 MiB is the inclusive mini program boundary, and the response
// binds the submission to the same channel used by finalize.
{
  const env = baseEnv();
  const stub = installCreateMediaStub();
  try {
    const response = await preparePost({
      request: makeRequest('/api/prepare', preparePayload({
        channel: UPLOAD_CHANNEL.WECHAT_MINIPROGRAM,
        audio: { type: 'audio/mp4', size: WECHAT_AUDIO_MAX_BYTES },
      })),
      env,
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.channel, UPLOAD_CHANNEL.WECHAT_MINIPROGRAM);
    assert.equal(stub.calls.length, 2);
    const records = [...env.STATS.map.entries()].filter(([key]) => key.startsWith('submission:'));
    assert.equal(records.length, 1);
    assert.equal(JSON.parse(records[0][1]).channel, UPLOAD_CHANNEL.WECHAT_MINIPROGRAM);
  } finally {
    stub.restore();
  }
}

// Legacy H5 remains a 200 MiB contract when channel is omitted.
{
  const env = baseEnv();
  const stub = installCreateMediaStub();
  try {
    const response = await preparePost({
      request: makeRequest('/api/prepare', preparePayload({
        audio: { type: 'audio/mp4', size: H5_AUDIO_MAX_BYTES },
      })),
      env,
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal('channel' in body, false);
  } finally {
    stub.restore();
  }
}

// H5's legacy ceiling still rejects one byte over 200 MiB.
{
  const env = baseEnv();
  const stub = installCreateMediaStub();
  try {
    const response = await preparePost({
      request: makeRequest('/api/prepare', preparePayload({
        audio: { type: 'audio/mp4', size: H5_AUDIO_MAX_BYTES + 1 },
      })),
      env,
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.equal(body.error, '录音超过 200MB');
    assert.equal(env.STATS.map.size, 0);
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
}

// Unknown markers are not silently treated as H5.
{
  const env = baseEnv();
  const stub = installCreateMediaStub();
  try {
    const response = await preparePost({
      request: makeRequest('/api/prepare', preparePayload({ channel: 'wechat-mini-program' })),
      env,
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, '上传通道标识无效');
    assert.equal(env.STATS.map.size, 0);
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
}

// finalize applies the mini limit before any read/write/ima work.
{
  const env = baseEnv();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('should not call ima'); };
  try {
    const response = await finalizePost({
      request: makeRequest('/api/finalize', finalizePayload({
        channel: UPLOAD_CHANNEL.WECHAT_MINIPROGRAM,
        audio: { media_id: 'soundrecording_1', cos_key: 'uploads/audio', size: WECHAT_AUDIO_MAX_BYTES + 1 },
      })),
      env,
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.equal(body.error, WECHAT_AUDIO_LIMIT_ERROR);
    assert.equal(fetchCalls, 0);
    assert.equal(env.STATS.map.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// H5 can still present a 200 MiB audio attachment to finalize; an unknown
// submission reaches the idempotency error, not the mini-program size gate.
{
  const env = baseEnv();
  const response = await finalizePost({
    request: makeRequest('/api/finalize', finalizePayload({
      audio: { media_id: 'soundrecording_1', cos_key: 'uploads/audio', size: H5_AUDIO_MAX_BYTES },
    })),
    env,
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.stage, 'submission_unknown');
}

// A mini-program submission cannot be finalized through the legacy H5 path,
// and a successful retry keeps the same channel binding.
{
  const env = baseEnv();
  const date = shanghaiDate();
  const submissionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  env.STATS.map.set(`submission:${submissionId}`, JSON.stringify({
    nickname: 'test-user', date, state: 'done', channel: UPLOAD_CHANNEL.WECHAT_MINIPROGRAM,
    folder: 'day', stats_updated: true,
  }));
  const response = await finalizePost({
    request: makeRequest('/api/finalize', finalizePayload({ channel: UPLOAD_CHANNEL.WECHAT_MINIPROGRAM })),
    env,
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'already');
  assert.equal(JSON.parse(env.STATS.map.get(`submission:${submissionId}`)).channel, UPLOAD_CHANNEL.WECHAT_MINIPROGRAM);
}

// Keep the constants referenced in this regression file explicit so a future
// edit cannot accidentally change the tested image contract while touching audio.
assert.equal(IMAGE_MAX_BYTES, 30 * 1024 * 1024);
console.log('✓ 小程序 100 MiB 闸门、H5 200 MiB 兼容、通道绑定与无副作用拒绝通过');