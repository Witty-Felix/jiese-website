// 微信小程序打卡客户端。
// 这里把选择、API 契约、COS 单次 PUT 和结果未知重交收在一个可测试的
// 公共边界；页面只负责输入状态和提示，不另造一套上传/重试协议。

const {
  AUDIO_MAX_BYTES,
  UPLOAD_CHANNEL,
  assertReadByteLength,
  chooseAudioFile,
  chooseImageFile,
  validateSelectedFile,
  withUploadChannel,
} = require('./upload-policy.js');

const DEFAULT_API_BASE_URL = 'https://api.324614917.xyz';
const PENDING_PREFIX = 'jiese-miniprogram-pending-v1';
const PENDING_VERSION = 1;
const REFLECTION_MAX = 2000;

class CheckinError extends Error {
  constructor(message, { code = 'checkin_error', stage, retryable, status, cause } = {}) {
    super(message);
    this.name = 'CheckinError';
    this.code = code;
    if (stage !== undefined) this.stage = stage;
    if (retryable !== undefined) this.retryable = retryable;
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

function makeError(message, options) {
  return new CheckinError(message, options);
}

function todayDate(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}

function parseJsonData(data) {
  if (data && typeof data === 'object') return data;
  if (typeof data === 'string' && data.trim()) {
    try { return JSON.parse(data); } catch { return null; }
  }
  return null;
}

function pendingKey(nickname) {
  return `${PENDING_PREFIX}:${nickname}`;
}

function defaultStorage(wx) {
  return {
    get(key) { return wx.getStorageSync(key); },
    set(key, value) { wx.setStorageSync(key, value); },
    remove(key) { wx.removeStorageSync(key); },
  };
}

function requestWithWx(wx, options) {
  return new Promise((resolve, reject) => {
    try {
      wx.request({ ...options, success: resolve, fail: reject });
    } catch (error) {
      reject(error);
    }
  });
}

function apiError(data, httpStatus) {
  const message = data?.error || '请求失败，请稍后重试';
  return makeError(message, {
    code: data?.stage || 'api_error',
    stage: data?.stage,
    retryable: data?.retryable,
    status: data?.status,
    cause: httpStatus ? { httpStatus } : undefined,
  });
}

function unknownResult(httpStatus, cause) {
  const suffix = httpStatus ? `（HTTP ${httpStatus}）` : '';
  return {
    ok: false,
    stage: 'result_unknown',
    retryable: true,
    error: `没有收到登记结果${suffix}，服务端可能已经登记。请点「重交本次登记」再试一次`,
    _httpStatus: httpStatus,
    _cause: cause,
  };
}

function validateClientSelection(file, kind) {
  const result = validateSelectedFile(file, kind);
  if (!result.ok) {
    throw makeError(result.error, { code: result.code || 'invalid_file', retryable: false });
  }
  return { ...file, size: result.size, type: result.mime };
}

function readSelectedFile(wx, selected, label) {
  return new Promise((resolve, reject) => {
    try {
      wx.getFileSystemManager().readFile({
        filePath: selected.path,
        success: ({ data }) => {
          try {
            resolve(assertReadByteLength(data, selected.size, label));
          } catch (error) {
            reject(error);
          }
        },
        fail: (cause) => reject(makeError(`${label}读取失败，请重新选择`, {
          code: 'read_failed', stage: 'readFile', retryable: true, cause,
        })),
      });
    } catch (cause) {
      reject(makeError(`${label}读取失败，请重新选择`, {
        code: 'read_failed', stage: 'readFile', retryable: true, cause,
      }));
    }
  });
}

function putCos(wx, item, bytes, contentType) {
  return new Promise((resolve, reject) => {
    try {
      wx.request({
        url: item.cos_url,
        method: 'PUT',
        header: {
          Authorization: item.authorization,
          'x-cos-security-token': item.token,
          'Content-Type': contentType,
          'Content-Length': String(bytes.byteLength),
        },
        data: bytes,
        responseType: 'text',
        success: (response) => {
          const status = Number(response?.statusCode || 0);
          if (status >= 200 && status < 300) {
            resolve(true);
            return;
          }
          reject(makeError(`材料直传失败（HTTP ${status || '未知'}），请重试`, {
            code: 'upload_failed', stage: 'cos_upload', retryable: true, status,
          }));
        },
        fail: (cause) => reject(makeError('材料直传网络错误，请重试', {
          code: 'upload_failed', stage: 'cos_upload', retryable: true, cause,
        })),
      });
    } catch (cause) {
      reject(makeError('材料直传网络错误，请重试', {
        code: 'upload_failed', stage: 'cos_upload', retryable: true, cause,
      }));
    }
  });
}

function createCheckinClient(wx, options = {}) {
  if (!wx || typeof wx.request !== 'function') {
    throw new TypeError('createCheckinClient 需要微信 wx API');
  }
  const apiBaseUrl = String(options.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const storage = options.storage || defaultStorage(wx);
  const now = options.now || (() => Date.now());

  async function requestApi(path, data, { unknownOnFailure = false } = {}) {
    let response;
    try {
      response = await requestWithWx(wx, {
        url: `${apiBaseUrl}${path}`,
        method: 'POST',
        header: { 'Content-Type': 'application/json' },
        data,
        dataType: 'json',
      });
    } catch (cause) {
      if (unknownOnFailure) return unknownResult(undefined, cause);
      throw makeError('网络错误，请检查网络后重试', { code: 'network_error', retryable: true, cause });
    }
    const dataObject = parseJsonData(response?.data);
    if (!dataObject) {
      if (unknownOnFailure) return unknownResult(response?.statusCode, response);
      throw makeError('服务器返回无法解析的响应，请重试', {
        code: 'invalid_response', retryable: true, status: response?.statusCode, cause: response,
      });
    }
    return { ...dataObject, _httpStatus: response?.statusCode };
  }

  async function verify(credentials) {
    const data = await requestApi('/api/verify', credentials);
    if (!data.ok) throw apiError(data, data._httpStatus);
    return data;
  }

  async function prepare(payload) {
    const data = await requestApi('/api/prepare', payload);
    if (!data.ok) throw apiError(data, data._httpStatus);
    return data;
  }

  async function finalize(payload) {
    return requestApi('/api/finalize', payload, { unknownOnFailure: true });
  }

  function getPending(nickname) {
    if (!nickname) return null;
    let value;
    try { value = storage.get(pendingKey(nickname)); } catch { return null; }
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { value = null; }
    }
    if (!value || value.version !== PENDING_VERSION || value.channel !== UPLOAD_CHANNEL || !value.submission_id) {
      if (value) { try { storage.remove(pendingKey(nickname)); } catch { /* best effort */ } }
      return null;
    }
    if (value.date !== todayDate(now())) {
      try { storage.remove(pendingKey(nickname)); } catch { /* best effort */ }
      return null;
    }
    return value;
  }

  function savePending(record) {
    try {
      storage.set(pendingKey(record.nickname), JSON.stringify(record));
    } catch (cause) {
      throw makeError('无法保存重交检查点，未登记本次打卡。请保持页面打开并重试', {
        code: 'checkpoint_failed', stage: 'checkpoint', retryable: false, cause,
      });
    }
  }

  function clearPending(nickname) {
    if (!nickname) return;
    try { storage.remove(pendingKey(nickname)); } catch { /* best effort */ }
  }

  async function finishSubmission({ nickname, invite_code, reflection, checkpoint, confirmDuplicateDay }) {
    const fixedReflection = String(reflection || '').trim().slice(0, REFLECTION_MAX);
    const base = {
      nickname,
      invite_code,
      channel: UPLOAD_CHANNEL,
      submission_id: checkpoint.submission_id,
      reflection: fixedReflection,
      image: checkpoint.image,
      audio: checkpoint.audio,
      ...(checkpoint.allow_duplicate_day ? { allow_duplicate_day: true } : {}),
    };
    let result = await finalize(base);
    if (!result.ok && result.status === 'duplicate_day') {
      const confirmed = typeof confirmDuplicateDay === 'function'
        ? await confirmDuplicateDay(result.error || '你今天已经打过卡了，确认要再登记一次吗？')
        : false;
      if (!confirmed) return { ok: false, status: 'cancelled', error: '已取消：今天的打卡记录保持不变。' };
      checkpoint.allow_duplicate_day = true;
      savePending(checkpoint);
      result = await finalize({ ...base, allow_duplicate_day: true });
    }
    if (!result.ok) {
      if (result.retryable === false) clearPending(nickname);
      throw makeError(result.error || '登记失败，请稍后重试', {
        code: result.stage || (result.status === 'duplicate_day' ? 'duplicate_day' : 'finalize_failed'),
        stage: result.stage,
        retryable: result.retryable,
        status: result.status,
        cause: result._cause,
      });
    }
    // ima 已登记但统计占位未补齐时必须保留检查点：下一次 finalize 会命中
    // already 分支，只补写 KV，不会再次触碰 ima。清理检查点意味着这条补救路径丢失。
    if (result.stats_updated !== false) clearPending(nickname);
    return result;
  }

  async function submit({ nickname, invite_code, reflection = '', image, audio, confirmDuplicateDay } = {}) {
    const cleanNickname = String(nickname || '').trim();
    const inviteCode = String(invite_code || '').trim();
    if (!cleanNickname || !inviteCode) {
      throw makeError('请填写昵称和邀请码', { code: 'missing_credentials', retryable: false });
    }

    const pending = getPending(cleanNickname);
    if (pending) {
      return finishSubmission({
        nickname: cleanNickname,
        invite_code: inviteCode,
        reflection: pending.reflection,
        checkpoint: pending,
        confirmDuplicateDay,
      });
    }

    if (!image || !audio) {
      throw makeError('请先选择运动截图和阅读录音', { code: 'missing_material', retryable: false });
    }
    const selectedImage = validateClientSelection(image, 'image');
    const selectedAudio = validateClientSelection(audio, 'audio');

    await verify({ nickname: cleanNickname, invite_code: inviteCode });
    const prepared = await prepare(withUploadChannel({
      nickname: cleanNickname,
      invite_code: inviteCode,
      image: { size: selectedImage.size, type: selectedImage.type },
      audio: { size: selectedAudio.size, type: selectedAudio.type },
    }));

    let confirmedDuplicateDay = false;
    if (prepared.already_today) {
      const confirmed = typeof confirmDuplicateDay === 'function'
        ? await confirmDuplicateDay('你今天已经打过卡了，确认要再登记一次吗？')
        : false;
      if (!confirmed) return { ok: false, status: 'cancelled', error: '已取消：今天的打卡记录保持不变。' };
      confirmedDuplicateDay = true;
    }

    // 临时路径只在当前小程序生命周期中有效：prepare 成功后立即读出，
    // 字节长度通过断言后才能进入两次单对象 PUT。
    const [imageBytes, audioBytes] = await Promise.all([
      readSelectedFile(wx, selectedImage, '截图'),
      readSelectedFile(wx, selectedAudio, '录音'),
    ]);
    await Promise.all([
      putCos(wx, prepared.image, imageBytes, selectedImage.type),
      putCos(wx, prepared.audio, audioBytes, selectedAudio.type),
    ]);

    const checkpoint = {
      version: PENDING_VERSION,
      nickname: cleanNickname,
      date: prepared.date || todayDate(now()),
      channel: UPLOAD_CHANNEL,
      submission_id: prepared.submission_id,
      reflection: String(reflection || '').trim().slice(0, REFLECTION_MAX),
      image: { media_id: prepared.image.media_id, cos_key: prepared.image.cos_key, size: selectedImage.size },
      audio: { media_id: prepared.audio.media_id, cos_key: prepared.audio.cos_key, size: selectedAudio.size },
      ...(confirmedDuplicateDay ? { allow_duplicate_day: true } : {}),
    };
    // 材料已全部到 COS，先落检查点，再发 finalize；否则结果未知时无法安全重交。
    savePending(checkpoint);
    return finishSubmission({
      nickname: cleanNickname,
      invite_code: inviteCode,
      reflection: checkpoint.reflection,
      checkpoint,
      confirmDuplicateDay,
    });
  }

  return {
    apiBaseUrl,
    chooseImageFile: () => chooseImageFile(wx),
    chooseAudioFile: () => chooseAudioFile(wx),
    clearPending,
    getPending,
    submit,
    verify,
  };
}

module.exports = {
  AUDIO_MAX_BYTES,
  DEFAULT_API_BASE_URL,
  PENDING_PREFIX,
  UPLOAD_CHANNEL,
  CheckinError,
  createCheckinClient,
  todayDate,
};
