// POST /api/checkin  multipart/form-data
//   nickname, invite_code, reflection(可选), image(必填), audio(必填)
// 流程：校验 → 图片(create_media→COS→add_knowledge) → 录音(同) → 笔记(import_doc→add_knowledge) → KV 记录
// 验证记录见 docs/adr/0001、0003、0004

import {
  MEDIA_TYPE, createMedia, cosUpload, addKnowledgeFile,
  importNote, addKnowledgeNote, getUserFolder, shanghaiDate, shanghaiDateTime,
} from './_ima.js';

const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{2,16}$/;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const AUDIO_TYPES = {
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
};
const IMAGE_MAX = 30 * 1024 * 1024; // ima 图片上限
const AUDIO_MAX = 95 * 1024 * 1024; // ima 上限 200MB，但 Cloudflare 免费版请求体约 100MB，留余量
const REFLECTION_MAX = 2000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function uploadFile(env, kbId, folderId, { bytes, mime, ext, mediaType, title }) {
  const cm = await createMedia(env, {
    kbId, fileName: `${title}.${ext}`, fileSize: bytes.byteLength,
    contentType: mime, fileExt: ext,
  });
  if (cm.code !== 0 || !cm.data?.media_id) {
    throw Object.assign(new Error(`创建媒体失败：${cm.msg}`), { stage: 'create_media' });
  }
  await cosUpload(cm.data.cos_credential, bytes, mime);
  const ak = await addKnowledgeFile(env, {
    kbId, folderId, mediaType, mediaId: cm.data.media_id,
    title, cosKey: cm.data.cos_credential.cos_key, fileSize: bytes.byteLength,
  });
  if (ak.code !== 0) {
    throw Object.assign(new Error(`附件入库失败：${ak.msg}`), { stage: 'add_knowledge' });
  }
}

export async function onRequestPost({ request, env }) {
  for (const v of ['IMA_OPENAPI_CLIENTID', 'IMA_OPENAPI_APIKEY', 'IMA_KB_ID', 'INVITE_CODE']) {
    if (!env[v]) return json({ ok: false, error: `服务端未配置 ${v}` }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: '请求体不是合法表单（或超过体积上限）' }, 400);
  }

  const nickname = String(form.get('nickname') || '').trim();
  const inviteCode = String(form.get('invite_code') || '').trim();
  const reflection = String(form.get('reflection') || '').trim().slice(0, REFLECTION_MAX);
  const image = form.get('image');
  const audio = form.get('audio');

  if (!NICK_RE.test(nickname)) return json({ ok: false, error: '昵称格式不正确' }, 400);
  if (inviteCode !== env.INVITE_CODE) return json({ ok: false, error: '邀请码不正确' }, 401);
  if (!(image instanceof File) || image.size === 0) return json({ ok: false, error: '缺少运动截图' }, 400);
  if (!(audio instanceof File) || audio.size === 0) return json({ ok: false, error: '缺少阅读录音' }, 400);
  if (!(image.type in IMAGE_TYPES)) return json({ ok: false, error: `运动截图仅支持 PNG/JPG/WebP，收到 ${image.type}` }, 400);
  if (!(audio.type in AUDIO_TYPES)) return json({ ok: false, error: `录音仅支持 MP3/M4A/WAV/AAC，收到 ${audio.type}` }, 400);
  if (image.size > IMAGE_MAX) return json({ ok: false, error: '运动截图超过 30MB' }, 413);
  if (audio.size > AUDIO_MAX) return json({ ok: false, error: '录音超过 95MB（站点上限）' }, 413);

  const kbId = env.IMA_KB_ID;
  const folderId = getUserFolder(env, nickname);
  const date = shanghaiDate();
  const dateTime = shanghaiDateTime();

  try {
    await uploadFile(env, kbId, folderId, {
      bytes: await image.arrayBuffer(), mime: image.type, ext: IMAGE_TYPES[image.type],
      mediaType: MEDIA_TYPE.IMAGE, title: `${nickname} 运动打卡 ${date}`,
    });
    await uploadFile(env, kbId, folderId, {
      bytes: await audio.arrayBuffer(), mime: audio.type, ext: AUDIO_TYPES[audio.type],
      mediaType: MEDIA_TYPE.AUDIO, title: `${nickname} 阅读录音 ${date}`,
    });

    const markdown = [
      `# ${nickname}的打卡 ${date}`,
      '',
      `- 打卡用户：${nickname}`,
      `- 打卡时间：${dateTime}`,
      '',
      '## 今日感悟',
      '',
      reflection || '（未填写）',
      '',
      '## 附件',
      '',
      '- 运动时长截图：已上传',
      '- 阅读戒色文章录音：已上传',
      '',
    ].join('\n');

    const note = await importNote(env, markdown);
    if (note.code !== 0 || !note.data) {
      throw Object.assign(new Error(`笔记创建失败：${note.msg}`), { stage: 'import_doc' });
    }
    const contentId = note.data.content_id || note.data.note_id || note.data?.data?.content_id;
    const akNote = await addKnowledgeNote(env, { kbId, folderId, contentId, title: `${nickname}的打卡 ${date}` });
    if (akNote.code !== 0) {
      throw Object.assign(new Error(`笔记入库失败：${akNote.msg}`), { stage: 'add_knowledge_note' });
    }
  } catch (e) {
    return json({ ok: false, error: e.message || 'ima 落库失败', stage: e.stage }, 502);
  }

  // 统计记录：写入失败不阻断打卡成功（ADR-0004）
  let statsUpdated = true;
  try {
    await env.STATS.put(`checkin:${date}:${nickname}`, JSON.stringify({ ts: Date.now() }));
  } catch {
    statsUpdated = false;
  }

  return json({ ok: true, date, stats_updated: statsUpdated });
}
