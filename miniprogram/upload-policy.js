// 微信小程序上传前置策略。
// chooseMessageFile 回调应在拿到 tempFiles 后调用 validateAudioSelection；
// readFile 得到 ArrayBuffer 后必须先调用 assertReadByteLength，再进入 COS PUT。

import { UPLOAD_CHANNEL as API_CHANNEL, WECHAT_AUDIO_MAX_BYTES, WECHAT_AUDIO_LIMIT_ERROR } from '../functions/api/_upload-contract.js';

export const UPLOAD_CHANNEL = API_CHANNEL.WECHAT_MINIPROGRAM;
export const AUDIO_MAX_BYTES = WECHAT_AUDIO_MAX_BYTES;
export const AUDIO_SIZE_ERROR = WECHAT_AUDIO_LIMIT_ERROR;

export function validateAudioSelection(tempFile) {
  const size = Number(tempFile?.size);
  if (!Number.isInteger(size) || size <= 0) {
    return { ok: false, error: '录音大小无效' };
  }
  if (size > AUDIO_MAX_BYTES) {
    return { ok: false, error: AUDIO_SIZE_ERROR };
  }
  return { ok: true, size };
}

export function assertReadByteLength(data, expectedSize, label = '附件') {
  const actualSize = data && typeof data.byteLength === 'number' ? data.byteLength : -1;
  if (actualSize !== expectedSize) {
    throw new Error(`${label}读取字节数不一致：${actualSize}/${expectedSize}`);
  }
  return data;
}

export function withUploadChannel(payload = {}) {
  return { ...payload, channel: UPLOAD_CHANNEL };
}


export function chooseAudioFile(wx) {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['mp3', 'm4a', 'wav', 'aac'],
      success: ({ tempFiles = [] }) => {
        const tempFile = tempFiles[0];
        const result = validateAudioSelection(tempFile);
        if (!result.ok) {
          reject(new Error(result.error));
          return;
        }
        resolve({ ...tempFile, size: result.size });
      },
      fail: reject,
    });
  });
}

export async function chooseAndReadAudio(wx) {
  const tempFile = await chooseAudioFile(wx);
  const data = await new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: tempFile.path,
      success: ({ data: bytes }) => resolve(bytes),
      fail: reject,
    });
  });
  return { tempFile, data: assertReadByteLength(data, tempFile.size, '录音') };
}
