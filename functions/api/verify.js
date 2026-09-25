// POST /api/verify  { nickname, invite_code } → { ok, nickname, folder }
// 邀请码存 Pages Secret，不进前端代码（ADR-0002）
// 本端点顺带「确保用户文件夹存在」（ADR-0008）：目录结构由系统维护，成员无感
import { ensureUserFolder } from './_ima.js';

const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{2,16}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export async function onRequestPost({ request, env }) {
  if (!env.INVITE_CODE) {
    return json({ ok: false, error: '服务端未配置邀请码' }, 500);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }
  const nickname = String(payload?.nickname || '').trim();
  const inviteCode = String(payload?.invite_code || '').trim();

  if (!NICK_RE.test(nickname)) {
    return json({ ok: false, error: '昵称需为 2–16 位中文、字母、数字或 ·_-，不含空格和冒号' }, 400);
  }
  if (inviteCode !== env.INVITE_CODE) {
    return json({ ok: false, error: '邀请码不正确' }, 401);
  }
  // 确保用户文件夹：失败不阻断登录，只在响应里如实暴露降级事实（folder=degraded）
  const folderId = await ensureUserFolder(env, nickname);
  return json({ ok: true, nickname, folder: folderId ? 'ready' : 'degraded' });
}
