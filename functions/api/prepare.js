// POST /api/prepare  JSON { nickname, invite_code, image: {size, type}, audio: {size, type} }
// 校验后调 create_media ×2，返回浏览器直传 COS 所需的预签名凭证（ADR-0005 直传架构第一步）
// 直传凭证不含任何长期密钥：只回传预签好的 Authorization 头 + COS 临时 token

import { createMedia, signCosAuthorization, buildCosUrl, shanghaiDate } from './_ima.js';

const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{2,16}$/;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const AUDIO_TYPES = {
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
};
const IMAGE_MAX = 30 * 1024 * 1024; // ima 图片上限
const AUDIO_MAX = 200 * 1024 * 1024; // ima 音频上限（直传后不再受 CF 100MB 请求体限制）

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function prepareOne(env, kbId, { size, mime, ext, mediaType, title, date }) {
  const cm = await createMedia(env, {
    kbId, fileName: `${title}.${ext}`, fileSize: size, contentType: mime, fileExt: ext,
  });
  if (cm.code !== 0 || !cm.data?.media_id) {
    throw Object.assign(new Error(`创建媒体失败：${cm.msg}`), { stage: 'create_media' });
  }
  const cred = cm.data.cos_credential;
  const { authorization } = await signCosAuthorization(cred, size);
  return {
    media_id: cm.data.media_id,
    cos_key: cred.cos_key,
    cos_url: buildCosUrl(cred),
    authorization,
    token: cred.token,
  };
}

export async function onRequestPost({ request, env }) {
  for (const v of ['IMA_OPENAPI_CLIENTID', 'IMA_OPENAPI_APIKEY', 'IMA_KB_ID', 'INVITE_CODE']) {
    if (!env[v]) return json({ ok: false, error: `服务端未配置 ${v}` }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const nickname = String(payload?.nickname || '').trim();
  const inviteCode = String(payload?.invite_code || '').trim();
  const image = payload?.image || {};
  const audio = payload?.audio || {};

  if (!NICK_RE.test(nickname)) return json({ ok: false, error: '昵称格式不正确' }, 400);
  if (inviteCode !== env.INVITE_CODE) return json({ ok: false, error: '邀请码不正确' }, 401);
  if (!(image.type in IMAGE_TYPES)) return json({ ok: false, error: '运动截图仅支持 PNG/JPG/WebP' }, 400);
  if (!(audio.type in AUDIO_TYPES)) return json({ ok: false, error: '录音仅支持 MP3/M4A/WAV/AAC' }, 400);
  if (!Number.isInteger(image.size) || image.size <= 0) return json({ ok: false, error: '截图大小无效' }, 400);
  if (!Number.isInteger(audio.size) || audio.size <= 0) return json({ ok: false, error: '录音大小无效' }, 400);
  if (image.size > IMAGE_MAX) return json({ ok: false, error: '运动截图超过 30MB' }, 413);
  if (audio.size > AUDIO_MAX) return json({ ok: false, error: '录音超过 200MB' }, 413);

  const kbId = env.IMA_KB_ID;
  const date = shanghaiDate();

  try {
    const [imgItem, audItem] = await Promise.all([
      prepareOne(env, kbId, { size: image.size, mime: image.type, ext: IMAGE_TYPES[image.type], mediaType: 9, title: `${nickname} 运动打卡 ${date}`, date }),
      prepareOne(env, kbId, { size: audio.size, mime: audio.type, ext: AUDIO_TYPES[audio.type], mediaType: 15, title: `${nickname} 阅读录音 ${date}`, date }),
    ]);
    return json({ ok: true, date, image: imgItem, audio: audItem });
  } catch (e) {
    return json({ ok: false, error: e.message || '准备直传失败', stage: e.stage }, 502);
  }
}
