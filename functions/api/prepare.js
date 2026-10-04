// POST /api/prepare  JSON { nickname, invite_code, channel?, image: {size, type}, audio: {size, type} }
// 校验后调 create_media ×2，返回浏览器/小程序直传 COS 所需的预签名凭证（ADR-0005 直传架构第一步）
// 直传凭证不含任何长期密钥：只回传预签好的 Authorization 头 + COS 临时 token
// 同时签发本次提交的 submission_id 并提前上报本日是否已打卡（ADR-0010）

import { createMedia, signCosAuthorization, buildCosUrl, shanghaiDate } from './_ima.js';
import { newSubmissionId, writeSubmission, hasCheckedInToday, SUBMISSION_STATE } from './_submission.js';
import {
  IMAGE_MAX_BYTES, IMAGE_LIMIT_ERROR, audioMaxBytes, audioLimitError, readUploadChannel,
  UPLOAD_CHANNEL,
} from './_upload-contract.js';

const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{2,16}$/;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const AUDIO_TYPES = {
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
};

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
  const channelResult = readUploadChannel(payload);
  if (channelResult.error) return json({ ok: false, error: channelResult.error }, 400);
  const channel = channelResult.channel;
  const image = payload?.image || {};
  const audio = payload?.audio || {};
  const audioMax = audioMaxBytes(channel);

  if (!NICK_RE.test(nickname)) return json({ ok: false, error: '昵称格式不正确' }, 400);
  if (inviteCode !== env.INVITE_CODE) return json({ ok: false, error: '邀请码不正确' }, 401);
  if (!(image.type in IMAGE_TYPES)) return json({ ok: false, error: '运动截图仅支持 PNG/JPG/WebP' }, 400);
  if (!(audio.type in AUDIO_TYPES)) return json({ ok: false, error: '录音仅支持 MP3/M4A/WAV/AAC' }, 400);
  if (!Number.isInteger(image.size) || image.size <= 0) return json({ ok: false, error: '截图大小无效' }, 400);
  if (!Number.isInteger(audio.size) || audio.size <= 0) return json({ ok: false, error: '录音大小无效' }, 400);
  if (image.size > IMAGE_MAX_BYTES) return json({ ok: false, error: IMAGE_LIMIT_ERROR }, 413);
  if (audio.size > audioMax) return json({ ok: false, error: audioLimitError(channel) }, 413);

  const kbId = env.IMA_KB_ID;
  const date = shanghaiDate();

  // 幂等记录先落（ADR-0010）：finalize 据此去重，重交才不会写第二次。
  // 刻意写在 create_media 之前——KV 落不下记录时直接失败，不留下没人认领的 ima 媒体对象。
  // 客户端的重交必须复用这个 id；重新 prepare 会换一个新的，服务端就认不出是同一次提交了。
  const submissionId = newSubmissionId();
  try {
    const submission = { nickname, date, state: SUBMISSION_STATE.PREPARED, ts: Date.now() };
    if (channel === UPLOAD_CHANNEL.WECHAT_MINIPROGRAM) submission.channel = channel;
    await writeSubmission(env, submissionId, submission);
  } catch {
    return json({ ok: false, error: '无法登记本次提交（服务端存储暂时不可用），请重试', stage: 'submission_write', retryable: true }, 503);
  }

  // 本日已有记录 → 提前告知，让成员在上传前就知道，而不是传完 200MB 才被挡。
  // 这里只是提前量；真正的闸门在 finalize（ADR-0010），客户端可以不听，服务端说了算。
  const alreadyToday = await hasCheckedInToday(env, date, nickname);
  if (alreadyToday === null) console.warn(`[prepare] 本日打卡状态读取失败，本次放行（${nickname} ${date}）`);

  try {
    const [imgItem, audItem] = await Promise.all([
      prepareOne(env, kbId, { size: image.size, mime: image.type, ext: IMAGE_TYPES[image.type], mediaType: 9, title: `${nickname} 运动打卡 ${date}`, date }),
      prepareOne(env, kbId, { size: audio.size, mime: audio.type, ext: AUDIO_TYPES[audio.type], mediaType: 15, title: `${nickname} 阅读录音 ${date}`, date }),
    ]);
    return json({
      ok: true,
      date,
      submission_id: submissionId,
      already_today: alreadyToday === true,
      ...(channel ? { channel } : {}),
      image: imgItem,
      audio: audItem,
    });
  } catch (e) {
    const status = e.stage === 'ima_auth' ? 503 : 502;
    return json({
      ok: false,
      error: e.message || '准备直传失败',
      stage: e.stage,
      retryable: e.stage !== 'ima_auth',
    }, status);
  }
}
