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

// 扣除已删日期后计算榜单行；无剩余记录返回 null。
// 统计接口与删除响应的重算行必须走同一口径，否则乐观更新会与刷新后的榜单打架（ADR-0007）
export function computeRowExcluding(nickname, dates, excluded, today) {
  for (const d of excluded) dates.delete(d);
  return dates.size ? computeRow(nickname, dates, today) : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHECKIN_PREFIX = 'checkin:';

export { DATE_RE };

// 解析 `checkin:<日期>:<昵称>` 键名；不合法返回 null。
// 键名解析只此一处：stats 与 admin 若各写一套，口径迟早漂移
export function parseCheckinKey(name) {
  if (!name.startsWith(CHECKIN_PREFIX)) return null;
  const rest = name.slice(CHECKIN_PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0) return null;
  const date = rest.slice(0, i);
  const nickname = rest.slice(i + 1);
  if (!DATE_RE.test(date) || !nickname) return null;
  return { date, nickname };
}

/* ---------- 删除标记（ADR-0007） ----------
 * 问题：KV 的 list 结果有最长约 60s 的最终一致延迟——键删掉后，list 仍会返回已删键，
 *      于是「整户清空 → 立即刷新」会看到记录复活，刷几次等同步窗口过去才消失。
 * 方案：把被删日期记在单键 `deleted:<昵称>`（值为日期数组）上，读取走 get。
 *      KV 在写入发生的 colo 会同步失效该键的读缓存，因此删除后紧接着的统计请求即可读到标记，
 *      据此把已删日期从 list 结果里减掉，绕过 list 的延迟。
 * 撤销：重新打卡（finalize）会移除该日期的标记，保证「删了当天重打」不被误伤。
 * 失败模式（降级方向永远选「多显示」而不是「隐藏真实记录」）：
 *   - 统计侧读到标记失败 → 返回空集合，等于不做过滤，最多短暂多显示已删行；
 *   - 写标记失败 → 不回滚删除，同样只是多显示；
 *   - 撤销标记时读失败 → 覆写为空标记（下面 removeDeletedDate），
 *     宁可让更早的已删行短暂复现，也不留下能永久隐藏合法打卡的残留标记。
 */

export const DELETED_PREFIX = 'deleted:';
const MAX_MARKED_DATES = 500; // KV 单值上限 25MB，此处仅作防御性上限

const deletedKey = (nickname) => DELETED_PREFIX + nickname;

// 严格读取：KV 故障时抛出，由调用方决定降级方向
async function readDeletedStrict(env, nickname) {
  const raw = await env.STATS.get(deletedKey(nickname));
  if (!raw) return new Set();
  try {
    const dates = JSON.parse(raw)?.dates;
    return new Set(Array.isArray(dates) ? dates.filter((d) => typeof d === 'string') : []);
  } catch {
    return new Set(); // 值损坏：当作无标记（降级方向安全）
  }
}

// 统计侧读取：读到失败视为无标记，绝不因此隐藏真实记录
export async function readDeletedDates(env, nickname) {
  try {
    return await readDeletedStrict(env, nickname);
  } catch {
    return new Set();
  }
}

async function writeDeletedDates(env, nickname, dates) {
  await env.STATS.put(
    deletedKey(nickname),
    JSON.stringify({ dates: [...dates].sort(), ts: Date.now() }),
  );
}

// 追加已删日期（合并既有标记）；无新增时不动键
export async function addDeletedDates(env, nickname, dates) {
  if (dates.size === 0) return;
  let base;
  try {
    base = await readDeletedStrict(env, nickname);
  } catch {
    base = new Set(); // 读失败：只记本次删除，代价是更早的标记丢失（最多短暂多显示）
  }
  for (const d of dates) base.add(d);
  await writeDeletedDates(env, nickname, [...base].sort().slice(-MAX_MARKED_DATES));
}

// 撤销某日期的删除标记（重新打卡成功后调用）；无标记时不写
export async function removeDeletedDate(env, nickname, date) {
  let base;
  try {
    base = await readDeletedStrict(env, nickname);
  } catch {
    // 读不到就无法定点撤销，只能清空标记。降级方向：最多让更早的已删行短暂复现，
    // 绝不留下会永久隐藏这条合法打卡的残留标记
    await writeDeletedDates(env, nickname, []);
    return;
  }
  if (!base.delete(date)) return;
  if (base.size === 0) {
    await env.STATS.delete(deletedKey(nickname));
    return;
  }
  await writeDeletedDates(env, nickname, [...base].sort());
}
