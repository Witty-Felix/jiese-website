import assert from 'node:assert/strict';
import { onRequestPost as preparePost } from '../functions/api/prepare.js';
import { onRequestPost as finalizePost } from '../functions/api/finalize.js';
import { shanghaiDate } from '../functions/api/_ima.js';
import { SUBMISSION_STATE, SUBMISSION_TTL } from '../functions/api/_submission.js';
import {
  H5_AUDIO_MAX_BYTES,
  WECHAT_AUDIO_MAX_BYTES,
  UPLOAD_CHANNEL,
} from '../functions/api/_upload-contract.js';

const TODAY = shanghaiDate();
const INVITE_CODE = 'test-code';
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeKv() {
  const map = new Map();
  const puts = [];
  const reads = [];
  const kv = {
    map,
    puts,
    reads,
    failCheckinPut: false,
    async get(key) {
      reads.push(key);
      return map.get(key) ?? null;
    },
    async put(key, value, options) {
      if (kv.failCheckinPut && key.startsWith('checkin:')) throw new Error('checkin write failed');
      puts.push({ key, value: String(value), options });
      map.set(key, String(value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
  return kv;
}

function makeIma() {
  const calls = [];
  let mediaSeq = 0;
  return {
    calls,
    fetch: async (url, init = {}) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ path, body });
      if (path.endsWith('/create_media')) {
        const isImage = String(body.content_type).startsWith('image/');
        mediaSeq += 1;
        const kind = isImage ? 'img' : 'soundrecording';
        return { json: async () => ({
          code: 0,
          msg: 'success',
          data: {
            media_id: `${kind}_${mediaSeq}`,
            cos_credential: {
              bucket_name: 'bucket', region: 'ap-shanghai', cos_key: `uploads/${kind}_${mediaSeq}`,
              secret_id: 'secret-id', secret_key: 'secret-key', token: 'token',
              start_time: '1700000000', expired_time: '1700003600',
            },
          },
        }) };
      }
      if (path.endsWith('/get_knowledge_list')) {
        const list = body.folder_id
          ? [{ media_id: 'folder-day', title: TODAY, media_type: 99 }]
          : [{ media_id: 'folder-user', title: 'member01', media_type: 99 }];
        return { json: async () => ({ code: 0, msg: 'success', data: { knowledge_list: list, is_end: true } }) };
      }
      if (path.endsWith('/create_folder')) {
        return { json: async () => ({ code: 1, msg: 'folder disabled in this test' }) };
      }
      if (path.endsWith('/add_knowledge')) {
        return { json: async () => ({ code: 0, msg: 'success', data: {} }) };
      }
      if (path.endsWith('/import_doc')) {
        return { json: async () => ({ code: 0, msg: 'success', data: { content_id: 'note-1' } }) };
      }
      throw new Error(`unexpected ima path: ${path}`);
    },
  };
}

function makeEnv() {
  const ima = makeIma();
  const STATS = makeKv();
  return {
    env: {
      INVITE_CODE,
      IMA_KB_ID: 'kb-test',
      IMA_OPENAPI_CLIENTID: 'client-id',
      IMA_OPENAPI_APIKEY: 'api-key',
      STATS,
    },
    ima,
    STATS,
  };
}

function request(path, body) {
  return new Request(`https://site.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function preparePayload(overrides = {}) {
  return {
    nickname: 'member01',
    invite_code: INVITE_CODE,
    image: { type: 'image/png', size: 1024 },
    audio: { type: 'audio/mp4', size: 2048 },
    ...overrides,
  };
}

function finalizePayload(prep = {}, overrides = {}) {
  return {
    nickname: 'member01',
    invite_code: INVITE_CODE,
    submission_id: prep.submission_id || UUID,
    reflection: '今天坚持练习',
    image: { media_id: prep.image?.media_id || 'img_1', cos_key: prep.image?.cos_key || 'uploads/image', size: 1024 },
    audio: { media_id: prep.audio?.media_id || 'soundrecording_1', cos_key: prep.audio?.cos_key || 'uploads/audio', size: 2048 },
    ...overrides,
  };
}

async function callPrepare(env, body) {
  const response = await preparePost({ request: request('/api/prepare', body), env });
  return { response, body: await response.json() };
}

async function callFinalize(env, body) {
  const response = await finalizePost({ request: request('/api/finalize', body), env });
  return { response, body: await response.json() };
}

async function withIma(fake, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function mediaCalls(ima) {
  return ima.calls.filter((call) => call.path.endsWith('/create_media'));
}
function registrationCalls(ima) {
  return ima.calls.filter((call) => call.path.endsWith('/add_knowledge') || call.path.endsWith('/import_doc'));
}

// Prepare issues a server-owned identity, stores it for 24 hours, and keeps the
// legacy H5 channel implicit.
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const { response, body } = await callPrepare(env, preparePayload({ audio: { type: 'audio/mp4', size: H5_AUDIO_MAX_BYTES } }));
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.match(body.submission_id, /^[0-9a-f-]{36}$/i);
    assert.equal(body.channel, undefined);
    const record = JSON.parse(STATS.map.get(`submission:${body.submission_id}`));
    assert.deepEqual(
      { nickname: record.nickname, date: record.date, state: record.state },
      { nickname: 'member01', date: TODAY, state: SUBMISSION_STATE.PREPARED },
    );
    assert.equal(STATS.puts.find((put) => put.key.startsWith('submission:')).options.expirationTtl, SUBMISSION_TTL);
    assert.equal(mediaCalls(ima).length, 2);
  });
}

// H5 compatibility and the channel-specific boundary are checked before any
// submission or ima side effect.
{
  const { env, ima } = makeEnv();
  await withIma(ima, async () => {
    const exact = await callPrepare(env, preparePayload({ audio: { type: 'audio/mp4', size: H5_AUDIO_MAX_BYTES } }));
    assert.equal(exact.response.status, 200);
    const registered = await callFinalize(env, finalizePayload(exact.body));
    assert.equal(registered.response.status, 200);
    assert.equal(registered.body.status, 'new');
  });
}
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const tooLarge = await callPrepare(env, preparePayload({ audio: { type: 'audio/mp4', size: H5_AUDIO_MAX_BYTES + 1 } }));
    assert.equal(tooLarge.response.status, 413);
    assert.equal(STATS.map.size, 0);
    assert.equal(mediaCalls(ima).length, 0);
  });
}
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const exact = await callPrepare(env, preparePayload({
      channel: UPLOAD_CHANNEL.WECHAT_MINIPROGRAM,
      audio: { type: 'audio/mp4', size: WECHAT_AUDIO_MAX_BYTES },
    }));
    assert.equal(exact.response.status, 200);
    assert.equal(exact.body.channel, UPLOAD_CHANNEL.WECHAT_MINIPROGRAM);
    const record = JSON.parse(STATS.map.get(`submission:${exact.body.submission_id}`));
    assert.equal(record.channel, UPLOAD_CHANNEL.WECHAT_MINIPROGRAM);
  });
}
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const tooLarge = await callPrepare(env, preparePayload({
      channel: UPLOAD_CHANNEL.WECHAT_MINIPROGRAM,
      audio: { type: 'audio/mp4', size: WECHAT_AUDIO_MAX_BYTES + 1 },
    }));
    assert.equal(tooLarge.response.status, 413);
    assert.equal(STATS.map.size, 0);
    assert.equal(mediaCalls(ima).length, 0);
  });
}
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const invalid = await callPrepare(env, preparePayload({ channel: 'wechat-mini-program' }));
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error, '上传通道标识无效');
    assert.equal(STATS.map.size, 0);
    assert.equal(mediaCalls(ima).length, 0);
  });
}

// An unissued, mismatched, or stale identity is a conflict with no ima/KV
// registration side effect. The valid media receipts make the identity check
// the observable seam rather than malformed-input validation.
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const unknown = await callFinalize(env, finalizePayload({ submission_id: UUID }));
    assert.equal(unknown.response.status, 409);
    assert.equal(unknown.body.stage, 'submission_unknown');
    assert.equal(registrationCalls(ima).length, 0);
    assert.equal([...STATS.map.keys()].some((key) => key.startsWith('checkin:')), false);
  });
}
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const prep = (await callPrepare(env, preparePayload())).body;
    const mismatch = await callFinalize(env, finalizePayload(prep, { nickname: 'other01' }));
    assert.equal(mismatch.response.status, 409);
    assert.equal(mismatch.body.stage, 'submission_mismatch');
    assert.equal(registrationCalls(ima).length, 0);
    assert.equal([...STATS.map.keys()].some((key) => key.startsWith('checkin:')), false);
  });
}
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    STATS.map.set(`submission:${UUID}`, JSON.stringify({
      nickname: 'member01', date: '2020-01-01', state: SUBMISSION_STATE.PREPARED, ts: Date.now(),
    }));
    const stale = await callFinalize(env, finalizePayload({ submission_id: UUID }));
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.stage, 'submission_mismatch');
    assert.equal(registrationCalls(ima).length, 0);
    assert.equal([...STATS.map.keys()].some((key) => key.startsWith('checkin:')), false);
  });
}

// One submission can be finalized once; a retry is already, and does not call
// ima or write KV when the stats placeholder was already repaired.
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const prep = (await callPrepare(env, preparePayload())).body;
    const first = await callFinalize(env, finalizePayload(prep));
    assert.equal(first.response.status, 200);
    assert.equal(first.body.status, 'new');
    const registrationCount = registrationCalls(ima).length;
    const putsAfterFirst = STATS.puts.length;
    ima.calls.length = 0;
    STATS.puts.length = 0;
    const second = await callFinalize(env, finalizePayload(prep));
    assert.deepEqual({ status: second.body.status, stats_updated: second.body.stats_updated }, { status: 'already', stats_updated: true });
    assert.equal(registrationCalls(ima).length, 0);
    assert.equal(STATS.puts.length, 0);
    assert.equal(registrationCount > 0, true);
    assert.equal(putsAfterFirst > 0, true);
  });
}

// If ima has completed but the stats write failed, an already retry may only
// repair stats; it still must not repeat ima registration.
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const prep = (await callPrepare(env, preparePayload())).body;
    STATS.failCheckinPut = true;
    const first = await callFinalize(env, finalizePayload(prep));
    assert.equal(first.body.status, 'new');
    assert.equal(first.body.stats_updated, false);
    const registrationCount = registrationCalls(ima).length;
    STATS.failCheckinPut = false;
    ima.calls.length = 0;
    const retry = await callFinalize(env, finalizePayload(prep));
    assert.equal(retry.body.status, 'already');
    assert.equal(retry.body.stats_updated, true);
    assert.equal(registrationCalls(ima).length, 0);
    assert.equal(registrationCount > 0, true);
  });
}

// The same-day gate is explicit confirmation, not a silent rejection of a
// deliberate second check-in.
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const prep = (await callPrepare(env, preparePayload())).body;
    STATS.map.set(`checkin:${TODAY}:member01`, JSON.stringify({ ts: Date.now() }));
    ima.calls.length = 0;
    const blocked = await callFinalize(env, finalizePayload(prep));
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.status, 'duplicate_day');
    assert.equal(registrationCalls(ima).length, 0);
    const allowed = await callFinalize(env, finalizePayload(prep, { allow_duplicate_day: true }));
    assert.equal(allowed.body.status, 'new');
  });
}

// The soft lock blocks a short concurrent retry and becomes recoverable after
// its window expires.
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const prep = (await callPrepare(env, preparePayload())).body;
    const key = `submission:${prep.submission_id}`;
    STATS.map.set(key, JSON.stringify({ nickname: 'member01', date: TODAY, state: SUBMISSION_STATE.INFLIGHT, ts: Date.now() }));
    const locked = await callFinalize(env, finalizePayload(prep));
    assert.equal(locked.response.status, 409);
    assert.equal(locked.body.stage, 'inflight');
    STATS.map.set(key, JSON.stringify({ nickname: 'member01', date: TODAY, state: SUBMISSION_STATE.INFLIGHT, ts: Date.now() - 61_000 }));
    const recovered = await callFinalize(env, finalizePayload(prep));
    assert.equal(recovered.body.status, 'new');
  });
}

{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const result = await callFinalize(env, {
      nickname: 'member01',
      invite_code: INVITE_CODE,
      submission_id: UUID,
      image: { media_id: 'img_1', cos_key: 'uploads/image', size: 1024 },
      audio: { media_id: 'soundrecording_1', cos_key: 'uploads/audio', size: H5_AUDIO_MAX_BYTES + 1 },
    });
    assert.equal(result.response.status, 413);
    assert.equal(result.body.error, '录音超过 200MB');
    assert.equal(STATS.reads.length, 0);
    assert.equal(registrationCalls(ima).length, 0);
  });
}

// finalize applies the channel-specific limit before reading a submission.
{
  const { env, ima, STATS } = makeEnv();
  await withIma(ima, async () => {
    const result = await callFinalize(env, {
      nickname: 'member01',
      invite_code: INVITE_CODE,
      submission_id: UUID,
      image: { media_id: 'img_1', cos_key: 'uploads/image', size: 1024 },
      audio: { media_id: 'soundrecording_1', cos_key: 'uploads/audio', size: WECHAT_AUDIO_MAX_BYTES + 1 },
      channel: UPLOAD_CHANNEL.WECHAT_MINIPROGRAM,
    });
    assert.equal(result.response.status, 413);
    assert.equal(result.body.error, '微信小程序录音不得超过 100 MB');
    assert.equal(STATS.reads.length, 0);
    assert.equal(registrationCalls(ima).length, 0);
  });
}

// A recovered inflight submission skips an ima child step that was already
// durably marked complete before the previous attempt failed.
{
  const { env, ima } = makeEnv();
  await withIma(ima, async () => {
    const key = `submission:${UUID}`;
    env.STATS.map.set(key, JSON.stringify({
      nickname: 'member01', date: TODAY, state: SUBMISSION_STATE.INFLIGHT,
      ts: Date.now() - 61_000, progress: { image_registered: true },
    }));
    const recovered = await callFinalize(env, finalizePayload({ submission_id: UUID }));
    assert.equal(recovered.body.status, 'new');
    const added = ima.calls.filter((call) => call.path.endsWith('/add_knowledge'));
    assert.equal(added.some((call) => call.body.media_id === 'img_1'), false);
    assert.equal(added.some((call) => call.body.media_id === 'soundrecording_1'), true);
  });
}

console.log('✓ submission_id 幂等、软锁、重复日期确认、H5/小程序大小契约通过');
