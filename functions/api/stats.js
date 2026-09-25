// GET /api/stats → 全员打卡统计（ADR-0004）
// KV 键：checkin:<yyyy-mm-dd>:<昵称>；日期按 Asia/Shanghai
// 返回：{ ok, today, rows: [{ nickname, total, streak, last_date, checked_today }] }
// no-store：KV list 本就有最终一致延迟，不能再叠加浏览器/中间层缓存，否则「刷新无效果」

import { shanghaiDate } from './_ima.js';
import { computeRow } from './_stats.js';

export async function onRequestGet({ env }) {
  if (!env.STATS) return new Response(JSON.stringify({ ok: false, error: '服务端未配置 STATS' }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  const byUser = new Map();
  let cursor;
  do {
    const page = await env.STATS.list({ prefix: 'checkin:', cursor });
    for (const k of page.keys) {
      const rest = k.name.slice('checkin:'.length);
      const i = rest.indexOf(':');
      if (i <= 0) continue;
      const date = rest.slice(0, i);
      const nick = rest.slice(i + 1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !nick) continue;
      if (!byUser.has(nick)) byUser.set(nick, new Set());
      byUser.get(nick).add(date);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const today = shanghaiDate();
  const rows = [...byUser.entries()]
    .map(([nickname, dates]) => computeRow(nickname, dates, today))
    .sort((a, b) => b.total - a.total || b.streak - a.streak || a.nickname.localeCompare(b.nickname, 'zh'));

  return new Response(JSON.stringify({ ok: true, today, rows }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
