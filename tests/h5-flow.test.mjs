import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const PAGE = HTML.replace(/<script src="app\.js[^"]*"><\/script>/, `<script>${APP}</script>`);

const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate, message, attempts = 250) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`等待超时：${message}`);
}

function boot(routes, seed = {}) {
  const calls = { prepare: [], finalize: [], stats: [], xhr: [] };
  const dom = new JSDOM(PAGE, {
    url: 'https://site.test/',
    runScripts: 'dangerously',
    beforeParse(window) {
      for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value);
      window.scrollTo = () => {};
      window.alert = () => {};
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
      window.XMLHttpRequest = class {
        constructor() { this.upload = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(name, value) { (this.headers ||= {})[name] = value; }
        send() {
          calls.xhr.push({ method: this.method, url: this.url, headers: this.headers });
          this.status = 200;
          setTimeout(() => this.onload?.(), 0);
        }
      };
      window.fetch = async (url, init = {}) => {
        const path = new URL(url, window.location.href).pathname;
        const key = path.replace('/api/', '');
        const body = init.body ? JSON.parse(init.body) : {};
        (calls[key] ||= []).push(body);
        const route = routes[key];
        const answer = typeof route === 'function' ? await route(calls[key].length - 1, body) : route;
        if (answer === 'network-error') throw new Error('network down');
        if (answer === 'unreadable') return { status: 504, json: async () => { throw new Error('gateway timeout'); } };
        if (answer === undefined) throw new Error(`未桩化端点：${path}`);
        return {
          status: answer.httpStatus ?? (answer.ok === false ? 409 : 200),
          json: async () => answer,
        };
      };
    },
  });
  return { window: dom.window, calls, close: () => dom.window.close() };
}

function loggedInSeed() {
  return { 'jiese-user-v1': JSON.stringify({ nickname: 'member01', invite_code: 'test-code' }) };
}

function pick(window, inputId, name, type, size) {
  const input = window.document.getElementById(inputId);
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name, type, size }] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function submit(window) {
  window.document.getElementById('checkin-form')
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function visible(window, id) {
  return !window.document.getElementById(id).hidden;
}

function prepareResponse(overrides = {}) {
  return {
    ok: true,
    date: today(),
    already_today: false,
    submission_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    image: { media_id: 'img_1', cos_key: 'uploads/image', cos_url: 'https://cos.test/image', authorization: 'sig', token: 'token' },
    audio: { media_id: 'soundrecording_1', cos_key: 'uploads/audio', cos_url: 'https://cos.test/audio', authorization: 'sig', token: 'token' },
    ...overrides,
  };
}

// A lost finalize response is an explicit unknown state. The retry reuses the
// original checkpoint, with no second prepare or COS PUT.
{
  const routes = {
    stats: { ok: true, today: today(), rows: [] },
    prepare: prepareResponse(),
    finalize: (index) => index === 0 ? 'network-error' : { ok: true, status: 'already', date: today(), stats_updated: true, folder: 'day' },
  };
  const { window, calls, close } = boot(routes, loggedInSeed());
  try {
    await waitFor(() => visible(window, 'view-checkin'), '进入打卡视图');
    pick(window, 'input-image', 'run.png', 'image/png', 1024);
    pick(window, 'input-audio', 'reading.m4a', 'audio/mp4', 2048);
    submit(window);
    await waitFor(() => visible(window, 'checkin-error'), '显示结果未知提示');

    assert.equal(calls.prepare.length, 1);
    assert.equal(calls.xhr.length, 2);
    assert.equal(calls.finalize.length, 1);
    assert.match(window.document.getElementById('checkin-error').textContent, /没有收到登记结果/);
    assert.equal(window.document.getElementById('checkin-btn').textContent, '重交本次登记');
    assert.ok(window.localStorage.getItem('jiese-pending-v1:member01'));

    submit(window);
    await waitFor(() => visible(window, 'view-done'), '重交完成');
    assert.equal(calls.prepare.length, 1);
    assert.equal(calls.xhr.length, 2);
    assert.equal(calls.finalize.length, 2);
    assert.equal(calls.finalize[1].submission_id, calls.finalize[0].submission_id);
    assert.match(window.document.getElementById('done-line').textContent, /重交/);
    assert.equal(window.localStorage.getItem('jiese-pending-v1:member01'), null);
  } finally {
    close();
  }
}

// A same-day duplicate is confirmed before upload when prepare can see it.
{
  let finalized;
  const routes = {
    stats: { ok: true, today: today(), rows: [] },
    prepare: prepareResponse({ already_today: true }),
    finalize: (index, body) => { finalized = { index, body }; return { ok: true, status: 'new', date: today(), stats_updated: true, folder: 'day' }; },
  };
  const { window, calls, close } = boot(routes, loggedInSeed());
  try {
    await waitFor(() => visible(window, 'view-checkin'), '进入打卡视图');
    pick(window, 'input-image', 'run.png', 'image/png', 1024);
    pick(window, 'input-audio', 'reading.m4a', 'audio/mp4', 2048);
    submit(window);
    await waitFor(() => visible(window, 'checkin-confirm'), '显示重复日期确认');
    assert.equal(calls.xhr.length, 0);
    window.document.getElementById('confirm-yes').click();
    await waitFor(() => visible(window, 'view-done'), '重复日期确认后完成');
    assert.equal(calls.finalize.length, 1);
    assert.equal(finalized.body.allow_duplicate_day, true);
    assert.equal(calls.xhr.length, 2);
  } finally {
    close();
  }
}

// If the date changes during upload, finalize can ask once at the authoritative
// gate; the same prepared submission is then retried with the confirmation.
{
  const routes = {
    stats: { ok: true, today: today(), rows: [] },
    prepare: prepareResponse(),
    finalize: (index) => index === 0
      ? { ok: false, status: 'duplicate_day', error: '你今天已经打过卡了，确认要再登记一次吗？' }
      : { ok: true, status: 'new', date: today(), stats_updated: true, folder: 'day' },
  };
  const { window, calls, close } = boot(routes, loggedInSeed());
  try {
    await waitFor(() => visible(window, 'view-checkin'), '进入打卡视图');
    pick(window, 'input-image', 'run.png', 'image/png', 1024);
    pick(window, 'input-audio', 'reading.m4a', 'audio/mp4', 2048);
    submit(window);
    await waitFor(() => visible(window, 'checkin-confirm'), '显示最终重复日期确认');
    assert.equal(calls.xhr.length, 2);
    window.document.getElementById('confirm-yes').click();
    await waitFor(() => visible(window, 'view-done'), '最终确认后完成');
    assert.equal(calls.prepare.length, 1);
    assert.equal(calls.finalize.length, 2);
    assert.equal(calls.finalize[1].allow_duplicate_day, true);
  } finally {
    close();
  }
}

// A known non-retryable response must not leave the old checkpoint as a
// misleading "retry this submission" action.
{
  const routes = {
    stats: { ok: true, today: today(), rows: [] },
    prepare: prepareResponse(),
    finalize: { ok: false, stage: 'ima_auth', retryable: false, error: 'ima 凭据无效，请联系管理员' },
  };
  const { window, calls, close } = boot(routes, loggedInSeed());
  try {
    await waitFor(() => visible(window, 'view-checkin'), '进入打卡视图');
    pick(window, 'input-image', 'run.png', 'image/png', 1024);
    pick(window, 'input-audio', 'reading.m4a', 'audio/mp4', 2048);
    submit(window);
    await waitFor(() => visible(window, 'checkin-error'), '显示不可重试错误');
    assert.equal(calls.prepare.length, 1);
    assert.equal(calls.finalize.length, 1);
    assert.equal(window.localStorage.getItem('jiese-pending-v1:member01'), null);
    assert.equal(window.document.getElementById('checkin-btn').textContent, '提交打卡');
    assert.match(window.document.getElementById('checkin-error').textContent, /凭据无效/);
  } finally {
    close();
  }
}

console.log('✓ H5 结果未知重交、重复日期确认与原提交复用流程通过');
