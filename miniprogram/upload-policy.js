// 微信小程序聊天媒体选择与读取前置策略。
// 该目录单独使用 CommonJS，便于直接被微信小程序页面 require；不依赖
// Cloudflare Functions 的运行时模块。服务端契约的字节常量在测试中交叉校验。

const UPLOAD_CHANNEL = 'wechat-miniprogram';
const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const AUDIO_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_SIZE_ERROR = '运动截图超过 30MB';
const AUDIO_SIZE_ERROR = '微信小程序录音不得超过 100 MB';

const FILE_TYPES = Object.freeze({
  image: Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }),
  audio: Object.freeze({ mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac' }),
});

function uploadError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  Object.assign(error, extra);
  return error;
}

function extensionOf(file) {
  const name = String(file?.name || file?.path || '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function mimeTypeOf(file, kind) {
  const expected = FILE_TYPES[kind]?.[extensionOf(file)];
  const actual = String(file?.type || '').toLowerCase();
  const supported = Object.values(FILE_TYPES[kind] || {});
  if (supported.includes(actual)) return actual;
  if (kind === 'audio' && actual === 'audio/x-m4a') return 'audio/mp4';
  if (kind === 'audio' && actual === 'audio/x-wav') return 'audio/wav';
  if (!expected) return null;
  if (!actual || actual === 'application/octet-stream' || actual === kind) return expected;
  return actual === expected ? expected : null;
}

function validateAudioSelection(tempFile) {
  const size = Number(tempFile?.size);
  if (!Number.isInteger(size) || size <= 0) {
    return { ok: false, error: '录音大小无效' };
  }
  if (size > AUDIO_MAX_BYTES) {
    return { ok: false, error: AUDIO_SIZE_ERROR };
  }
  return { ok: true, size };
}

function validateImageSelection(tempFile) {
  const size = Number(tempFile?.size);
  if (!Number.isInteger(size) || size <= 0) {
    return { ok: false, error: '截图大小无效' };
  }
  if (size > IMAGE_MAX_BYTES) {
    return { ok: false, error: IMAGE_SIZE_ERROR };
  }
  return { ok: true, size };
}

function validateSelectedFile(tempFile, kind) {
  const sizeResult = kind === 'image' ? validateImageSelection(tempFile) : validateAudioSelection(tempFile);
  if (!sizeResult.ok) {
    return { ...sizeResult, code: sizeResult.error.includes('超过') ? 'too_large' : 'invalid_size' };
  }
  const mime = mimeTypeOf(tempFile, kind);
  if (!mime) {
    return {
      ok: false,
      error: kind === 'image' ? '运动截图类型不支持，仅支持 PNG/JPG/WebP' : '录音类型不支持，仅支持 MP3/M4A/WAV/AAC',
      code: 'unsupported_type',
    };
  }
  return { ok: true, size: sizeResult.size, mime };
}

function normalizeChooseFailure(raw) {
  const message = String(raw?.errMsg || raw?.message || '').toLowerCase();
  if (message.includes('cancel')) {
    return uploadError('cancelled', '已取消选择材料');
  }
  return uploadError('choose_failed', '打开微信聊天选择器失败，请重试', { cause: raw });
}

function chooseMessageFile(wx, kind) {
  return new Promise((resolve, reject) => {
    const options = kind === 'image'
      ? { count: 1, type: 'image' }
      : { count: 1, type: 'file', extension: ['mp3', 'm4a', 'wav', 'aac'] };
    wx.chooseMessageFile({
      ...options,
      success: ({ tempFiles = [] } = {}) => {
        const tempFile = tempFiles[0];
        if (!tempFile || tempFiles.length !== 1) {
          reject(uploadError('cancelled', '未选择材料'));
          return;
        }
        const result = validateSelectedFile(tempFile, kind);
        if (!result.ok) {
          reject(uploadError(result.code, result.error));
          return;
        }
        resolve({ ...tempFile, size: result.size, type: result.mime });
      },
      fail: (error) => reject(normalizeChooseFailure(error)),
    });
  });
}

function chooseImageFile(wx) {
  return chooseMessageFile(wx, 'image');
}

function chooseAudioFile(wx) {
  return chooseMessageFile(wx, 'audio');
}

function assertReadByteLength(data, expectedSize, label = '附件') {
  const actualSize = data && typeof data.byteLength === 'number' ? data.byteLength : -1;
  if (actualSize !== expectedSize) {
    throw uploadError('read_size_mismatch', `${label}读取字节数不一致：${actualSize}/${expectedSize}`);
  }
  return data;
}

function withUploadChannel(payload = {}) {
  return { ...payload, channel: UPLOAD_CHANNEL };
}

function chooseAndReadAudio(wx) {
  return chooseAudioFile(wx).then((tempFile) => new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: tempFile.path,
      success: ({ data }) => {
        try {
          resolve({ tempFile, data: assertReadByteLength(data, tempFile.size, '录音') });
        } catch (error) {
          reject(error);
        }
      },
      fail: (error) => reject(uploadError('read_failed', '读取录音失败，请重新选择', { cause: error })),
    });
  }));
}

module.exports = {
  AUDIO_MAX_BYTES,
  AUDIO_SIZE_ERROR,
  FILE_TYPES,
  IMAGE_MAX_BYTES,
  IMAGE_SIZE_ERROR,
  UPLOAD_CHANNEL,
  assertReadByteLength,
  chooseAndReadAudio,
  chooseAudioFile,
  chooseImageFile,
  mimeTypeOf,
  validateAudioSelection,
  validateImageSelection,
  validateSelectedFile,
  withUploadChannel,
};
