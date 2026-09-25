// 打卡统计行计算的共享工具（stats.js / admin/checkin.js / finalize.js 共用；下划线前缀不参与路由）

export function yesterdayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 由某用户的全量打卡日期集合计算榜单行（与 /api/stats 口径一致）
export function computeRow(nickname, dates, today) {
  const yesterday = yesterdayOf(today);
  const sorted = [...dates].sort().reverse(); // 新→旧
  let streak = 0;
  let expect = dates.has(today) ? today : (dates.has(yesterday) ? yesterday : null);
  while (expect && dates.has(expect)) {
    streak += 1;
    expect = yesterdayOf(expect);
  }
  return {
    nickname,
    total: dates.size,
    streak,
    last_date: sorted[0],
    checked_today: dates.has(today),
  };
}

/* ---------- 删除标记（ADR-0007） ----------
 * 问题：KV 的 list 结果有最长约 60s 的最终一致延迟——键删掉后，list 仍会返回已删键，
 *      于是「整户清空 → 立即刷新」会看到记录复活，刷几次等同步窗口过去才消失。
 * 方案：把被删日期记在单键 `deleted:<昵称>`（值为日期数组）上，读取走 get。
 *      KV 在写入发生的 colo 会同步失效该键的读缓存，因此删除后紧接着的统计请求即可读到标记，
 *      据此把已删日期从 list 结果里减掉，绕过 list 的延迟。
 * 撤销：重新打卡（finalize）会移除该日期的标记，保证「删了当天重打」不被误伤。
 * 失败模式：标记不可读或写失败时，统计退化为旧行为（最多短暂多显示已删行），
 *          不会导致真实记录被隐藏或丢失——标记本身是可再生的辅助数据。
 */

export const DELETED_PREFIX = 'deleted:';
const MAX_MARKED_DATES = 500; // KV 单值上限 25MB，此处仅作防御性上限

function parseDates(json) {
  try {
    const dates = JSON.parse(json)?.dates;
    return new Set(Array.isArray(dates) ? dates.filter((d) => typeof d === 'string') : []);
  } catch {
    return new Set();
  }
}

// 读某昵称的已删日期集合；不存在或不可读时返回空集合
export async function readDeletedDates(env, nickname) {
  try {
    const raw = await env.STATS.get(DELETED_PREFIX + nickname);
    return raw ? parseDates(raw) : new Set();
  } catch {
    return new Set();
  }
}

// 追加已删日期（合并既有标记）
export async function addDeletedDates(env, nickname, dates) {
  const merged = await readDeletedDates(env, nickname);
  for (const d of dates) merged.add(d);
  const kept = [...merged].sort().slice(-MAX_MARKED_DATES);
  await env.STATS.put(
    DELETED_PREFIX + nickname,
    JSON.stringify({ dates: kept, ts: Date.now() }),
  );
}

// 撤销某日期的删除标记（重新打卡成功后调用）；无标记时不写
export async function removeDeletedDate(env, nickname, date) {
  const merged = await readDeletedDates(env, nickname);
  if (!merged.delete(date)) return;
  if (merged.size === 0) {
    await env.STATS.delete(DELETED_PREFIX + nickname);
    return;
  }
  await env.STATS.put(
    DELETED_PREFIX + nickname,
    JSON.stringify({ dates: [...merged].sort(), ts: Date.now() }),
  );
}
