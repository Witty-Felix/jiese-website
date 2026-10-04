// 提交幂等记录（ADR-0010）：`submission:<submission_id>` 承载「一次提交」的身份与状态。
// prepare 签发、finalize 认领；下划线前缀不参与路由。
// 键名与状态口径只此一处——prepare 与 finalize 若各写一套，重交的安全性迟早漂移。

export const SUBMISSION_PREFIX = 'submission:';
// 跨自然日即失效：记录里本就绑着日期，隔天重交必然走新一轮 prepare
export const SUBMISSION_TTL = 24 * 60 * 60;
// inflight 软锁的有效窗口（秒级即可——它只挡「同一次提交的两份请求撞在一起」）
export const INFLIGHT_WINDOW_MS = 60 * 1000;

export const SUBMISSION_STATE = {
  PREPARED: 'prepared', // 凭证已下发，等 finalize 认领
  INFLIGHT: 'inflight', // 正在登记（软锁）
  DONE: 'done', // 三样内容已进 ima —— 此后任何重交都必须返回 already
};

// 只接受 prepare 自己签发的形态（crypto.randomUUID）
export const SUBMISSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newSubmissionId() {
  return crypto.randomUUID();
}

const submissionKey = (id) => SUBMISSION_PREFIX + id;

// 读取：KV 故障时抛出，由调用方决定降级方向（与 _stats.readDeletedStrict 同一约定）
export async function readSubmission(env, id) {
  const raw = await env.STATS.get(submissionKey(id));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    // 值损坏：当作不存在。客户端会退回到「重新提交」，比让一次来路不明的重交落地安全
    return null;
  }
}

export async function writeSubmission(env, id, rec) {
  await env.STATS.put(submissionKey(id), JSON.stringify(rec), { expirationTtl: SUBMISSION_TTL });
}

export const checkinKey = (date, nickname) => `checkin:${date}:${nickname}`;

/* ---------- 自然日判定 ----------
 * 「今天是不是已经打过卡」只能靠**单键 get**：打卡对单个键是即时的，
 * 不像 list() 有最长约 60s 的最终一致延迟——而「去打卡榜核对」那道人工兜底，
 * 正是被那层延迟坑过的地方（榜单可能显示"今天没记录"，实际已经登记成功）。
 *
 * 返回 null 表示**判不了**（基础设施故障）。调用方必须把 null 当作「放行」：
 * 宁可偶发重复登记，也不能因 KV 故障让成员打不上卡（ADR-0004 / 0008 一贯的降级方向：
 * 降级永远倒向「多做一次无用功」，不倒向「挡住一次真实动作」）。
 */
export async function hasCheckedInToday(env, date, nickname) {
  try {
    return (await env.STATS.get(checkinKey(date, nickname))) !== null;
  } catch {
    return null;
  }
}
