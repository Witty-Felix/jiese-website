// ima OpenAPI 共享库：鉴权头、建媒体、COS 直传、落库
// 验证记录见 docs/adr/0001（create_media → COS PUT → add_knowledge 全链路已端到端跑通）

const IMA_BASE = 'https://ima.qq.com/openapi';

// media_type 枚举（官方 api.md）
export const MEDIA_TYPE = {
  IMAGE: 9, // image/png | image/jpeg | image/webp，≤30MB
  AUDIO: 15, // ≤200MB、≤2h
  NOTE: 11,
};

export function imaHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'ima-openapi-clientid': env.IMA_OPENAPI_CLIENTID,
    'ima-openapi-apikey': env.IMA_OPENAPI_APIKEY,
  };
}

async function imaPost(env, path, body) {
  const res = await fetch(IMA_BASE + path, {
    method: 'POST',
    headers: imaHeaders(env),
    body: JSON.stringify(body),
  });
  return res.json(); // { code, msg, data }
}

// Step 1：创建媒体，取得 media_id + COS 临时凭证
export async function createMedia(env, { kbId, fileName, fileSize, contentType, fileExt }) {
  return imaPost(env, '/wiki/v1/create_media', {
    knowledge_base_id: kbId,
    file_name: fileName,
    file_size: fileSize,
    content_type: contentType,
    file_ext: fileExt,
  });
}

const enc = (s) => new TextEncoder().encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hmacSha1Hex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc(msg)));
}
async function sha1Hex(msg) {
  return hex(await crypto.subtle.digest('SHA-1', enc(msg)));
}

// COS 预签名（content-length + host，对齐官方 cos-upload.cjs 签名面）
export function buildCosUrl(cred) {
  return `https://${cred.bucket_name}.cos.${cred.region}.myqcloud.com/${cred.cos_key}`;
}

export async function signCosAuthorization(cred, fileSize) {
  const host = `${cred.bucket_name}.cos.${cred.region}.myqcloud.com`;
  const keyTime = `${cred.start_time};${cred.expired_time}`;
  const signKey = await hmacSha1Hex(cred.secret_key, keyTime);

  const signHeaders = { 'content-length': String(fileSize), host };
  const names = Object.keys(signHeaders).sort();
  const headerList = names.join(';');
  const httpHeaders = names.map((k) => `${k}=${encodeURIComponent(signHeaders[k])}`).join('&');
  const httpString = `put\n/${cred.cos_key}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${await sha1Hex(httpString)}\n`;
  const signature = await hmacSha1Hex(signKey, stringToSign);

  const authorization =
    `q-sign-algorithm=sha1&q-ak=${cred.secret_id}&q-sign-time=${keyTime}` +
    `&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=` +
    `&q-signature=${signature}`;
  return { authorization, host };
}

// Step 2：COS PUT 直传（服务端转发场景）
export async function cosUpload(cred, bytes, contentType) {
  const { authorization, host } = await signCosAuthorization(cred, bytes.byteLength);

  const res = await fetch(`https://${host}/${cred.cos_key}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'x-cos-security-token': cred.token,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: bytes,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 1400);
    throw new Error(`COS 上传失败 HTTP ${res.status} ${detail}`);
  }
  return true;
}

// Step 3：文件落库（图片/录音），folder_id 省略则落 KB 根目录
export async function addKnowledgeFile(env, { kbId, folderId, mediaType, mediaId, title, cosKey, fileSize }) {
  const body = {
    media_type: mediaType,
    media_id: mediaId,
    title,
    knowledge_base_id: kbId,
    file_info: { cos_key: cosKey, file_size: fileSize, last_modify_time: Math.floor(Date.now() / 1000) },
  };
  if (folderId) body.folder_id = folderId;
  return imaPost(env, '/wiki/v1/add_knowledge', body);
}

// 笔记：先 import_doc 拿 content_id，再 add_knowledge
export async function importNote(env, markdown) {
  return imaPost(env, '/note/v1/import_doc', { content_format: 1, content: markdown });
}

export async function addKnowledgeNote(env, { kbId, folderId, contentId, title }) {
  const body = {
    media_type: MEDIA_TYPE.NOTE,
    note_info: { content_id: contentId },
    title,
    knowledge_base_id: kbId,
  };
  if (folderId) body.folder_id = folderId;
  return imaPost(env, '/wiki/v1/add_knowledge', body);
}

/* ---------- 目录结构：用户文件夹 / 日期文件夹（ADR-0008） ----------
 * 接口契约（2026-09-25 实测）：POST /wiki/v1/create_folder，body { knowledge_base_id, name, folder_id? }
 *   - 父级字段名**就是 `folder_id`**；写成 parent_folder_id 之类会被 protojson 静默忽略
 *   - 省略 folder_id 建在知识库根目录；支持任意层级嵌套；name 限 1–255 字符
 *   - 返回 { code: 0, data: { media_id } }，该 media_id 即 folder_id
 *   - **非幂等**：同父级下重名 → code 220001「已存在同名知识」⇒ 必须「先查后建」
 *   - **传入不存在的 folder_id 不报错**，会静默落到根目录 ⇒ 写入后必须回读校验
 *   - 重名只在同一父级内冲突 ⇒ 各成员各自的日期文件夹不会互撞
 * 官方 api.md（1.1.3 为最新）仍未收录该接口：服务端跑在文档前面，能力以实测为准。
 */
const FOLDER_MEDIA_TYPE = 99; // get_knowledge_list 中文件夹条目的 media_type
const ALREADY_EXISTS_CODE = 220001;
const LIST_PAGE_SIZE = 50; // 服务端单页上限
// 枚举上限（10 页 × 50 = 500 条），防御游标异常导致的无界翻页。
// 实测列表为**新→旧**排序，因此当天新建的日期文件夹必在第一页；该上限只影响极端规模下的兜底。
const MAX_LIST_PAGES = 10;

async function createFolder(env, { kbId, name, parentFolderId }) {
  const body = { knowledge_base_id: kbId, name };
  if (parentFolderId) body.folder_id = parentFolderId;
  return imaPost(env, '/wiki/v1/create_folder', body);
}

async function listKnowledge(env, { kbId, folderId, cursor = '' }) {
  const body = { knowledge_base_id: kbId, limit: LIST_PAGE_SIZE, cursor };
  if (folderId) body.folder_id = folderId;
  return imaPost(env, '/wiki/v1/get_knowledge_list', body);
}

// 在指定层级下按精确名称（大小写敏感）查找文件夹
// 命中 → folder_id；未命中 → undefined；底层失败 → 抛出（交由 ensureFolder 降级）
async function findFolder(env, { kbId, parentFolderId, name }) {
  let cursor = '';
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const res = await listKnowledge(env, { kbId, folderId: parentFolderId, cursor });
    if (res.code !== 0) {
      throw Object.assign(new Error(`枚举文件夹失败：${res.msg}`), { stage: 'get_knowledge_list' });
    }
    const list = res.data?.knowledge_list || [];
    const hit = list.find((it) => it.media_type === FOLDER_MEDIA_TYPE && it.title === name);
    if (hit?.media_id) return hit.media_id;
    // 终止只认 is_end：实测 next_cursor 即使已到末尾仍返回非空串，用 cursor 判空会多查一轮
    if (res.data?.is_end) return undefined;
    cursor = res.data?.next_cursor || '';
    if (!cursor) return undefined;
  }
  return undefined;
}

// 「确保存在」原语：查 → 建 → 回读。三步缺一不可（非幂等 + 静默落根，见文件头契约）。
// 任何失败都返回 undefined 并留下告警，绝不抛出——登录与打卡不因目录故障而失败（ADR-0008 降级表）。
async function ensureFolder(env, opts) {
  try {
    const existing = await findFolder(env, opts);
    if (existing) return existing;

    const res = await createFolder(env, opts);
    if (res.code !== 0 && res.code !== ALREADY_EXISTS_CODE) {
      throw Object.assign(new Error(`创建文件夹失败：${res.msg}`), { stage: 'create_folder' });
    }
    // 新建成功 → 回读确认确实落在预期父级下（父级无效时会静默落根）
    // 并发撞名（220001）→ 重新枚举取回复用。两种情况共用同一次读取
    return await findFolder(env, opts);
  } catch (e) {
    console.warn(`[ima] 文件夹确保失败（${opts.name}）：${e.message || e}`);
    return undefined;
  }
}

// 用户文件夹：知识库根目录下、以**昵称原文**命名，不做任何归一化。
// 大小写敏感是刻意的——必须与 `checkin:<日期>:<昵称>`、榜单行、删除审计完全同一口径；
// 若「聪明地」合并写法，会出现「一个人两个文件夹、榜单两行」的外溢矛盾。
export async function ensureUserFolder(env, nickname) {
  if (!env.IMA_KB_ID) {
    // 部署缺配置属运维故障：必须留痕，否则「全员 degraded」会无从定位
    console.warn('[ima] 未配置 IMA_KB_ID，无法确保用户文件夹');
    return undefined;
  }
  return ensureFolder(env, { kbId: env.IMA_KB_ID, parentFolderId: undefined, name: nickname });
}

// 日期文件夹：用户文件夹下、以 YYYY-MM-DD（Asia/Shanghai）命名。
// 父级由调用方**显式传入**，使「日期文件夹只能建在自己的用户文件夹内，否则就不建」成为签名层面的保证：
// 拿不到用户文件夹时直接返回 undefined，绝不会在根目录建当日日期文件夹——
// 否则两位成员同时降级且同日打卡时，后人会按重名规则复用前人的日期文件夹，造成内容静默混流。
export async function ensureDayFolder(env, userFolderId, date) {
  if (!env.IMA_KB_ID || !userFolderId) return undefined;
  return ensureFolder(env, { kbId: env.IMA_KB_ID, parentFolderId: userFolderId, name: date });
}

// 时区工具：本站业务日期一律按 Asia/Shanghai
export function shanghaiDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}
export function shanghaiDateTime(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600e3).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
}
