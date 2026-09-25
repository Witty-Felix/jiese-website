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

// Step 2：COS PUT 直传（签名算法对齐官方 cos-upload.cjs：签名 content-length + host）
export async function cosUpload(cred, bytes, contentType) {
  const host = `${cred.bucket_name}.cos.${cred.region}.myqcloud.com`;
  const keyTime = `${cred.start_time};${cred.expired_time}`;
  const signKey = await hmacSha1Hex(cred.secret_key, keyTime);

  const signHeaders = {
    'content-length': String(bytes.byteLength),
    host,
  };
  const names = Object.keys(signHeaders).sort();
  const headerList = names.join(';');
  const httpHeaders = names.map((k) => `${k}=${encodeURIComponent(signHeaders[k])}`).join('&');
  const httpString = `put\n/${cred.cos_key}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${await sha1Hex(httpString)}\n`;
  const signature = await hmacSha1Hex(signKey, stringToSign);

  const auth =
    `q-sign-algorithm=sha1&q-ak=${cred.secret_id}&q-sign-time=${keyTime}` +
    `&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=` +
    `&q-signature=${signature}`;

  const res = await fetch(`https://${host}/${cred.cos_key}`, {
    method: 'PUT',
    headers: {
      Authorization: auth,
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

// 用户文件夹映射（ADR-0003 回退路径）：IMA_USER_FOLDERS 为 JSON 字符串 {"昵称":"folder_xxx"}
// 未配置或无该用户映射时返回 undefined → 落 KB 根目录
export function getUserFolder(env, nickname) {
  if (!env.IMA_USER_FOLDERS) return undefined;
  try {
    return JSON.parse(env.IMA_USER_FOLDERS)[nickname];
  } catch {
    return undefined;
  }
}

// 时区工具：本站业务日期一律按 Asia/Shanghai
export function shanghaiDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}
export function shanghaiDateTime(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600e3).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
}
