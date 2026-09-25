// POST /api/finalize  JSON { nickname, invite_code, reflection, image: {media_id, cos_key, size}, audio: {...} }
// 浏览器直传 COS 完成后调用：add_knowledge ×2 + 笔记链路 + KV 统计（ADR-0005 直传架构第三步）

import {
  MEDIA_TYPE, addKnowledgeFile, importNote, addKnowledgeNote,
  getUserFolder, shanghaiDate, shanghaiDateTime,
} from './_ima.js';
import { removeDeletedDate } from './_stats.js';

const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{2,16}$/;
const IMAGE_MAX = 30 * 1024 * 1024;
const AUDIO_MAX = 200 * 1024 * 1024;
const REFLECTION_MAX = 2000;
// 直传后对象由 ima 分配，media_id 有固定前缀；cos_key 为服务端 prepare 下发的路径
const MEDIA_ID_RE = { img: /^img_[A-Za-z0-9_]+$/, audio: /^soundrecording_[A-Za-z0-9_]+$/ };
const COS_KEY_RE = /^[A-Za-z0-9/_\-.]+$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function validateItem(item, kind, max) {
  if (!item || typeof item !== 'object') return '缺少附件回执';
  if (!MEDIA_ID_RE[kind].test(String(item.media_id || ''))) return `${kind === 'img' ? '截图' : '录音'}回执无效`;
  if (!COS_KEY_RE.test(String(item.cos_key || '')) || String(item.cos_key).length > 512) return '对象路径无效';
  if (!Number.isInteger(item.size) || item.size <= 0 || item.size > max) return '附件大小无效';
  return null;
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
  const reflection = String(payload?.reflection || '').trim().slice(0, REFLECTION_MAX);
  const image = payload?.image;
  const audio = payload?.audio;

  if (!NICK_RE.test(nickname)) return json({ ok: false, error: '昵称格式不正确' }, 400);
  if (inviteCode !== env.INVITE_CODE) return json({ ok: false, error: '邀请码不正确' }, 401);
  for (const [item, kind, max] of [[image, 'img', IMAGE_MAX], [audio, 'audio', AUDIO_MAX]]) {
    const err = validateItem(item, kind, max);
    if (err) return json({ ok: false, error: err }, 400);
  }

  const kbId = env.IMA_KB_ID;
  const folderId = getUserFolder(env, nickname);
  const date = shanghaiDate();
  const dateTime = shanghaiDateTime();

  try {
    const imgJob = addKnowledgeFile(env, {
      kbId, folderId, mediaType: MEDIA_TYPE.IMAGE, mediaId: image.media_id,
      title: `${nickname} 运动打卡 ${date}`, cosKey: image.cos_key, fileSize: image.size,
    }).then((r) => {
      if (r.code !== 0) throw Object.assign(new Error(`截图入库失败：${r.msg}`), { stage: 'add_knowledge' });
    });
    const audJob = addKnowledgeFile(env, {
      kbId, folderId, mediaType: MEDIA_TYPE.AUDIO, mediaId: audio.media_id,
      title: `${nickname} 阅读录音 ${date}`, cosKey: audio.cos_key, fileSize: audio.size,
    }).then((r) => {
      if (r.code !== 0) throw Object.assign(new Error(`录音入库失败：${r.msg}`), { stage: 'add_knowledge' });
    });
    const noteJob = (async () => {
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
    })();

    await Promise.all([imgJob, audJob, noteJob]);
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
  // 撤销该日删除标记（ADR-0007）：必须独立成一次尝试——标记操作失败不能连带让这条合法打卡写不进去。
  // 撤销失败时统计可能仍隐藏该日记录，故一并计入 statsUpdated（false = 统计不可信）
  try {
    await removeDeletedDate(env, nickname, date);
  } catch {
    statsUpdated = false;
  }

  return json({ ok: true, date, stats_updated: statsUpdated });
}
