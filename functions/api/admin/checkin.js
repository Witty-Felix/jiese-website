// DELETE /api/admin/checkin  （ADR-0006）
//   { admin_password, operator, nickname, date }      → 单条删除（该用户当天可重新打卡）
//   { admin_password, operator, nickname, all: true } → 整户清空（从打卡榜消失）
// 数据边界：仅作用于 KV checkin:* 统计记录；ima 内容无站内删除通道，只能在 ima 客户端自行删除
// 审计：audit:del:<ISO时间戳>:<operator>，只写不读，追责时到 Cloudflare KV 控制台按前缀查看
// 删除标记（ADR-0007）：删除后写 deleted:<昵称> 记录被删日期，供 /api/stats 用 get 绕开
//   KV list 的最终一致延迟（最长约 60s），否则清空后立即刷新会看到已删记录「复活」
// 响应附带 row（该用户重算后的榜单行，口径与 /api/stats 完全一致，null = 已无记录），
//   marked = 删除标记是否写入成功，前端据此提示「刷新后可能短暂复现」

import { json, requireAdmin } from './_auth.js';
import { shanghaiDate } from '../_ima.js';
import { DATE_RE, addDeletedDates, computeRowExcluding, parseCheckinKey, readDeletedDates } from '../_stats.js';

const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{2,16}$/;
const OP_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{1,32}$/;

// 列出某昵称的全部 checkin 键名（排除 exclude 集合）；KV list 最终一致，删除后需显式排除刚删的键
async function listUserKeys(env, nickname, exclude) {
  const names = [];
  let cursor;
  do {
    const page = await env.STATS.list({ prefix: 'checkin:', cursor });
    for (const k of page.keys) {
      if (exclude.has(k.name)) continue;
      if (parseCheckinKey(k.name)?.nickname === nickname) names.push(k.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

// 从键名中提取日期集合（键名解析口径由 _stats.js 统一提供）
function datesFromKeys(names, nickname) {
  const dates = new Set();
  for (const name of names) {
    const parsed = parseCheckinKey(name);
    if (parsed && parsed.nickname === nickname) dates.add(parsed.date);
  }
  return dates;
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
  let rest = [];
  let removedDates = new Set();
  if (all) {
    const keys = await listUserKeys(env, nickname, new Set());
    removedDates = datesFromKeys(keys, nickname);
    for (const name of keys) {
      await env.STATS.delete(name);
      deleted += 1;
    }
    // 显式排除刚删的键，绕过 KV list 的最终一致延迟
    rest = await listUserKeys(env, nickname, new Set(keys));
  } else {
    const key = `checkin:${date}:${nickname}`;
    const existing = await env.STATS.get(key);
    if (existing === null) {
      return json({ ok: false, error: `记录不存在：${nickname} ${date}` }, 404);
    }
    await env.STATS.delete(key);
    deleted = 1;
    removedDates = new Set([date]);
    rest = await listUserKeys(env, nickname, new Set([key]));
  }

  // 删除标记：写失败不回滚删除（统计退化为旧行为，最多短暂多显示已删行）
  let marked = true;
  try {
    await addDeletedDates(env, nickname, removedDates);
  } catch {
    marked = false;
  }

  // 重算行必须与 /api/stats 同口径：扣除本次删除日期 + 已持久化的删除标记。
  // 否则 list 延迟会让更早删掉的日期在乐观更新里短暂回流，与刷新后的真实榜单打架
  const excluded = await readDeletedDates(env, nickname);
  for (const d of removedDates) excluded.add(d);
  const row = computeRowExcluding(nickname, datesFromKeys(rest, nickname), excluded, shanghaiDate());

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

  return json({ ok: true, scope: all ? 'user' : 'day', deleted, audit_written: auditWritten, marked, row });
}
