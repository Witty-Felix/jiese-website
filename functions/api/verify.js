// POST /api/verify  { nickname, invite_code } → { ok }
// 邀请码存 Pages Secret，不进前端代码（ADR-0002）

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
  return json({ ok: true, nickname });
}
