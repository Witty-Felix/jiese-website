// POST /api/finalize  JSON { nickname, invite_code, channel?, submission_id, reflection, allow_duplicate_day?, image: {media_id, cos_key, size}, audio: {...} }
// 浏览器/小程序直传 COS 完成后调用：幂等闸门 → 确保日期文件夹 → add_knowledge ×2 + 笔记链路 → KV 统计（ADR-0005 直传架构第三步）
// 「结果未知 → 安全重交」由 submission_id 保证；「今天已打过卡」由自然日闸门显式确认（ADR-0010）

import {
  MEDIA_TYPE, addKnowledgeFile, importNote, addKnowledgeNote,
  ensureUserFolder, ensureDayFolder, shanghaiDate, shanghaiDateTime,
} from './_ima.js';
import { removeDeletedDate } from './_stats.js';
import {
  SUBMISSION_ID_RE, SUBMISSION_STATE, INFLIGHT_WINDOW_MS,
  readSubmission, writeSubmission, hasCheckedInToday, checkinKey,
} from './_submission.js';
import {
  IMAGE_MAX_BYTES, IMAGE_LIMIT_ERROR, audioMaxBytes, audioLimitError, channelInSubmission, readUploadChannel,
} from './_upload-contract.js';

const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9·_\-]{2,16}$/;
const REFLECTION_MAX = 2000;
// 直传后对象由 ima 分配，media_id 有固定前缀；cos_key 为服务端 prepare 下发的路径
const MEDIA_ID_RE = { img: /^img_[A-Za-z0-9_]+$/, audio: /^soundrecording_[A-Za-z0-9_]+$/ };
const COS_KEY_RE = /^[A-Za-z0-9/_\-.]+$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function validateItem(item, kind, max, tooLargeMessage = '附件大小无效') {
  if (!item || typeof item !== 'object') return { message: '缺少附件回执', status: 400 };
  if (!MEDIA_ID_RE[kind].test(String(item.media_id || ''))) {
    return { message: `${kind === 'img' ? '截图' : '录音'}回执无效`, status: 400 };
  }
  if (!COS_KEY_RE.test(String(item.cos_key || '')) || String(item.cos_key).length > 512) {
    return { message: '对象路径无效', status: 400 };
  }
  if (!Number.isInteger(item.size) || item.size <= 0) return { message: '附件大小无效', status: 400 };
  if (item.size > max) return { message: tooLargeMessage, status: 413 };
  return null;
}

const FOLDER_LEVELS = ['day', 'user', 'root'];

// 重交命中时的统计补写。**正常情况一个字都不写**——重交必须零副作用，否则「幂等」二字就是空的。
// 只有「素材已进 ima、统计还没落」那个极端窗口（进程在两次 KV 写之间被打断）才走到补写：
// checkin 是覆盖写、撤销删除标记是定点删，两次写都幂等，重复执行不会多算一天。
async function reconcileStats(env, submissionId, nickname, date, rec) {
  if (rec.stats_updated === true) {
    return { stats_updated: true, folder: FOLDER_LEVELS.includes(rec.folder) ? rec.folder : 'day' };
  }
  let statsUpdated = true;
  try {
    await env.STATS.put(checkinKey(date, nickname), JSON.stringify({ ts: Date.now() }));
  } catch {
    statsUpdated = false;
  }
  try {
    await removeDeletedDate(env, nickname, date);
  } catch {
    statsUpdated = false;
  }
  try {
    await writeSubmission(env, submissionId, { ...rec, state: SUBMISSION_STATE.DONE, stats_updated: statsUpdated, ts: Date.now() });
  } catch {
    console.warn(`[finalize] 统计补写后无法更新提交状态（${nickname} ${date}）`);
  }
  return { stats_updated: statsUpdated, folder: FOLDER_LEVELS.includes(rec.folder) ? rec.folder : 'day' };
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
  const reflection = String(payload?.reflection || '').trim().slice(0, REFLECTION_MAX);
  const image = payload?.image;
  const audio = payload?.audio;
  const submissionId = String(payload?.submission_id || '').trim();
  // 只认严格的布尔 true —— 缺字段、字符串 "true"、任意真值都不算用户确认过
  const allowDuplicateDay = payload?.allow_duplicate_day === true;
  const audioMax = audioMaxBytes(channel);

  if (!NICK_RE.test(nickname)) return json({ ok: false, error: '昵称格式不正确' }, 400);
  if (inviteCode !== env.INVITE_CODE) return json({ ok: false, error: '邀请码不正确' }, 401);
  if (!SUBMISSION_ID_RE.test(submissionId)) {
    return json({ ok: false, error: '缺少或非法的提交标识，请重新提交', stage: 'submission_missing' }, 400);
  }
  const imageError = validateItem(image, 'img', IMAGE_MAX_BYTES, IMAGE_LIMIT_ERROR);
  if (imageError) return json({ ok: false, error: imageError.message }, imageError.status);
  const audioError = validateItem(audio, 'audio', audioMax, audioLimitError(channel));
  if (audioError) return json({ ok: false, error: audioError.message }, audioError.status);

  const kbId = env.IMA_KB_ID;
  const date = shanghaiDate();
  const dateTime = shanghaiDateTime();

  /* ---------- 幂等闸门（ADR-0010）----------
   * 刻意排在一切写入（目录、ima、统计）之前：命中重交时必须一个字都不写，
   * 「会不会产生第二次登记」的答案才干净地是「不会」。
   */
  let rec;
  try {
    rec = await readSubmission(env, submissionId);
  } catch {
    return json({ ok: false, error: '无法读取本次提交的状态，请重试', stage: 'submission_read', retryable: true }, 503);
  }
  if (!rec) {
    // 过期 / 从未签发 / 客户端自己编的：一律拒绝，绝不落库。
    // TTL 只有 24 小时，所以「隔天重交」也会走到这里——那本就该是新的一次打卡。
    return json({ ok: false, error: '本次提交已过期或不存在，请重新提交', stage: 'submission_unknown' }, 409);
  }
  if (rec.nickname !== nickname || rec.date !== date) {
    return json({ ok: false, error: '本次提交与当前昵称或日期不匹配，请重新提交', stage: 'submission_mismatch' }, 409);
  }
  if (channelInSubmission(rec) !== channel) {
    return json({ ok: false, error: '本次提交与上传通道不匹配，请使用原通道重新提交', stage: 'submission_channel_mismatch' }, 409);
  }
  if (rec.state === SUBMISSION_STATE.DONE) {
    // 重交命中：本次提交此前已经登记成功，零副作用返回。
    // 唯一例外是「素材已进 ima、统计还没落」那个极端窗口，由 reconcileStats 补写（两次写都是幂等的）
    return json({ ok: true, status: 'already', date, ...(await reconcileStats(env, submissionId, nickname, date, rec)) });
  }
  if (rec.state === SUBMISSION_STATE.INFLIGHT && Date.now() - Number(rec.ts || 0) < INFLIGHT_WINDOW_MS) {
    return json({ ok: false, error: '本次提交正在登记中，请稍候再试', stage: 'inflight', retryable: true }, 409);
  }

  /* ---------- 自然日闸门：只确认、不拒绝（ADR-0010）----------
   * 「同一天可多次打卡」是现有产品规则，本票不动它。
   * 这里做的是把「重复登记」从静默发生改成用户显式选择——因为原型托付的那道
   * 「去打卡榜核对」并不可靠（榜单走 list()，最长约 60s 才可见）。
   */
  const alreadyToday = await hasCheckedInToday(env, date, nickname);
  if (alreadyToday === null) {
    console.warn(`[finalize] 本日打卡状态读取失败，本次放行（${nickname} ${date}）`);
  } else if (alreadyToday && !allowDuplicateDay) {
    return json({ ok: false, status: 'duplicate_day', error: '你今天已经打过卡了，确认要再登记一次吗？', stage: 'duplicate_day' }, 409);
  }

  // 软锁：KV 没有 CAS，「读状态 → 干活 → 写状态」做不到严格互斥（ADR-0010 已如实写明）。
  // 它挡的是「同一次提交的两份请求撞在一起」，不是并发上限。
  try {
    await writeSubmission(env, submissionId, { ...rec, state: SUBMISSION_STATE.INFLIGHT, ts: Date.now() });
  } catch {
    console.warn(`[finalize] 无法写入 inflight 状态，本次登记未加锁（${nickname} ${date}）`);
  }

  // 目录结构（ADR-0008）：用户文件夹 → 日期文件夹，必须在任何 add_knowledge 之前就位。
  // 分层降级：打卡永不因文件夹失败而失败；且日期文件夹只可能建在自己的用户文件夹内，否则不建。
  const userFolderId = await ensureUserFolder(env, nickname);
  const dayFolderId = await ensureDayFolder(env, userFolderId, date);
  const folderId = dayFolderId || userFolderId; // 无日期文件夹 → 退回用户文件夹；再无 → 根目录
  const folderLevel = dayFolderId ? 'day' : (userFolderId ? 'user' : 'root');
  if (folderLevel !== 'day') {
    // 降级如实暴露，不静默隐藏（响应里的 folder 字段 + 此处日志）
    console.warn(`[finalize] 目录降级为 ${folderLevel}（${nickname} ${date}）`);
  }

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
    // 明确的失败（我方拿到了回执）→ 把软锁放掉，让用户能立刻重交，而不是对着
    // 「正在登记中」干等 60 秒。部分写入已进 ima 的重复风险，等锁自然过期同样存在，
    // 这里不新增风险，只是不再把「失败」谎报成「进行中」。
    try {
      await writeSubmission(env, submissionId, { ...rec, state: SUBMISSION_STATE.PREPARED, ts: Date.now() });
    } catch { /* 放锁失败：锁会在 60 秒后自然过期，不影响正确性 */ }
    return json({ ok: false, error: e.message || 'ima 落库失败', stage: e.stage, retryable: e.stage !== 'ima_auth' }, e.stage === 'ima_auth' ? 503 : 502);
  }

  /* ---------- 分界线：三样内容已进 ima ----------
   * 必须**此刻**就把「已登记」钉死，而不是等统计写完。ima 侧没有任何站内删除通道，
   * 素材重复写进去就永远回不来了；反过来，统计晚一步是有救的（下方 already 路径会补写）。
   * 这一笔因此带 stats_updated:false 占位，写完统计后再覆盖成真值。
   */
  try {
    await writeSubmission(env, submissionId, {
      ...rec, nickname, date, state: SUBMISSION_STATE.DONE, folder: folderLevel, stats_updated: false, ts: Date.now(),
    });
  } catch {
    // 钉不住就等于没有重交保护，但登记本身是成功的——如实告警，不回滚已落库的内容
    console.warn(`[finalize] 无法写入已登记状态，重交可能重复登记（${nickname} ${date}）`);
  }

  // 统计记录：写入失败不阻断打卡成功（ADR-0004）
  let statsUpdated = true;
  try {
    await env.STATS.put(checkinKey(date, nickname), JSON.stringify({ ts: Date.now() }));
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

  // 把占位换成真值：此后重交命中 already，且不必再补写统计
  try {
    await writeSubmission(env, submissionId, {
      ...rec, nickname, date, state: SUBMISSION_STATE.DONE, folder: folderLevel, stats_updated: statsUpdated, ts: Date.now(),
    });
  } catch {
    console.warn(`[finalize] 无法更新提交状态，重交将补写一次统计（${nickname} ${date}）`);
  }

  return json({ ok: true, status: 'new', date, stats_updated: statsUpdated, folder: folderLevel });
}
