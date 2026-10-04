// WeChat mini program upload policy shared by the chooseMessageFile callback
// and the readFile → COS PUT chain.  The production mini program can require
// this module without importing any browser or Cloudflare code.

const UPLOAD_CHANNEL = 'wechat-miniprogram';
const AUDIO_MAX_BYTES = 100 * 1024 * 1024;
const AUDIO_SIZE_ERROR = '微信小程序录音不得超过 100 MB';

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

function assertReadByteLength(data, expectedSize, label = '附件') {
  const actualSize = data && typeof data.byteLength === 'number' ? data.byteLength : -1;
  if (actualSize !== expectedSize) {
    throw new Error(`${label}读取字节数不一致：${actualSize}/${expectedSize}`);
  }
  return data;
}

function withUploadChannel(payload = {}) {
  return { ...payload, channel: UPLOAD_CHANNEL };
}

module.exports = {
  AUDIO_MAX_BYTES,
  AUDIO_SIZE_ERROR,
  UPLOAD_CHANNEL,
  assertReadByteLength,
  validateAudioSelection,
  withUploadChannel,
};