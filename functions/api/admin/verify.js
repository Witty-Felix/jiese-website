// POST /api/admin/verify  { admin_password } → { ok }
// 前端解锁管理模式前校验管理密码（ADR-0006）；无会话，密码由前端 sessionStorage 随每次删除请求携带

import { json, requireAdmin } from './_auth.js';

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }
  const denied = requireAdmin(env, String(payload?.admin_password || ''));
  if (denied) return denied;
  return json({ ok: true });
}
