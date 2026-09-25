// 管理端点公共工具（ADR-0006）：常量时间比对 + 统一 JSON 响应

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 字符串常量时间比对：长度不等也走完整轮次，消除时序侧信道
export function timingSafeEqualStr(a, b) {
  const ab = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// 校验管理密码；通过返回 null，否则返回可直接下发的错误 Response
export function requireAdmin(env, adminPassword) {
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '服务端未配置 ADMIN_PASSWORD' }, 500);
  }
  if (!adminPassword || !timingSafeEqualStr(adminPassword, env.ADMIN_PASSWORD)) {
    return json({ ok: false, error: '管理密码不正确' }, 401);
  }
  return null;
}
