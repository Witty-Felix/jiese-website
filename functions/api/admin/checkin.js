// DELETE /api/admin/checkin  （ADR-0006）
//   { admin_password, operator, nickname, date }      → 单条删除（该用户当天可重新打卡）
//   { admin_password, operator, nickname, all: true } → 整户清空（从打卡榜消失）
// 数据边界：仅作用于 KV checkin:* 统计记录；ima 内容无站内删除通道，只能在 ima 客户端自行删除
// 审计：audit:del:<ISO时间戳>:<operator>，只写不读，追责时到 Cloudflare KV 控制台按前缀查看
// 响应附带 row（该用户重算后的榜单行）：KV list 最终一致（最长约 60s），前端据其做本地即时更新，
// 避免删除后重新拉 /api/stats 时短暂「复活」已删记录

import { json, requireAdmin } from './_auth.js';
import { shanghaiDate } from '../_ima.js';
import { computeRow } from '../_stats.js';

const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{2,16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OP_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{1,32}$/;

// 列出某昵称的全部 checkin 键名（排除 exclude 集合）；KV list 最终一致，删除后需显式排除刚删的键
async function listUserKeys(env, nickname, exclude) {
  const names = [];
  let cursor;
  do {
    const page = await env.STATS.list({ prefix: 'checkin:', cursor });
    for (const k of page.keys) {
      if (!exclude.has(k.name) && k.name.endsWith(`:${nickname}`)) names.push(k.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

// 由剩余键名重算该用户的榜单行（无剩余记录时返回 null）
function rowFromKeys(nickname, names) {
  const dates = new Set();
  for (const name of names) {
    const d = name.slice('checkin:'.length, name.length - nickname.length - 1);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
  }
  return dates.size ? computeRow(nickname, dates, shanghaiDate()) : null;
}

export async function onRequestDelete({ request, env }) {
  if (!env.STATS) return json({ ok: false, error: '服务端未配置 STATS' }, 500);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const adminPassword = String(payload?.admin_password || '');
  const operator = String(payload?.operator || '').trim();
  const nickname = String(payload?.nickname || '').trim();
  const all = payload?.all === true;
  const date = String(payload?.date || '').trim();

  const denied = requireAdmin(env, adminPassword);
  if (denied) return denied;
  if (!OP_RE.test(operator)) return json({ ok: false, error: '操作者昵称无效' }, 400);
  if (!NICK_RE.test(nickname)) return json({ ok: false, error: '目标昵称格式不正确' }, 400);
  if (!all && !DATE_RE.test(date)) return json({ ok: false, error: 'date 需为 yyyy-mm-dd' }, 400);

  let deleted = 0;
  let row = null;
  if (all) {
    const keys = await listUserKeys(env, nickname, new Set());
    for (const name of keys) {
      await env.STATS.delete(name);
      deleted += 1;
    }
    // 重算剩余行：显式排除刚删的键，绕过 KV list 的最终一致延迟
    row = rowFromKeys(nickname, await listUserKeys(env, nickname, new Set(keys)));
  } else {
    const key = `checkin:${date}:${nickname}`;
    const existing = await env.STATS.get(key);
    if (existing === null) {
      return json({ ok: false, error: `记录不存在：${nickname} ${date}` }, 404);
    }
    await env.STATS.delete(key);
    deleted = 1;
    row = rowFromKeys(nickname, await listUserKeys(env, nickname, new Set([key])));
  }

  // 审计只写不读：写失败不回滚删除，仅在响应中标记
  let auditWritten = true;
  try {
    await env.STATS.put(
      `audit:del:${new Date().toISOString()}:${operator}`,
      JSON.stringify({
        target: nickname,
        scope: all ? 'user' : 'day',
        date: all ? undefined : date,
        deleted,
        ts: Date.now(),
      }),
    );
  } catch {
    auditWritten = false;
  }

  return json({ ok: true, scope: all ? 'user' : 'day', deleted, audit_written: auditWritten, row });
}
