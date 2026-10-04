// Shared upload-channel contract.
//
// The H5 client predates the channel field and deliberately omits it.  Keep
// that omission meaningful: it selects the legacy 200 MiB browser contract.
// The WeChat mini program opts into the stricter single-ArrayBuffer contract
// with the exact `wechat-miniprogram` marker.

export const UPLOAD_CHANNEL = Object.freeze({
  WECHAT_MINIPROGRAM: 'wechat-miniprogram',
});

export const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
export const H5_AUDIO_MAX_BYTES = 200 * 1024 * 1024;
export const WECHAT_AUDIO_MAX_BYTES = 100 * 1024 * 1024;

export const IMAGE_LIMIT_ERROR = '运动截图超过 30MB';
export const WECHAT_AUDIO_LIMIT_ERROR = '微信小程序录音不得超过 100 MB';
export const H5_AUDIO_LIMIT_ERROR = '录音超过 200MB';

/**
 * Read the optional channel marker without silently accepting typos.
 *
 * An omitted marker is the compatibility path for the existing H5 client.
 * Any present value must be the one marker this API currently supports.
 */
export function readUploadChannel(payload) {
  if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'channel')) {
    return { channel: null };
  }
  if (payload.channel === UPLOAD_CHANNEL.WECHAT_MINIPROGRAM) {
    return { channel: UPLOAD_CHANNEL.WECHAT_MINIPROGRAM };
  }
  return { error: '上传通道标识无效' };
}

export function audioMaxBytes(channel) {
  return channel === UPLOAD_CHANNEL.WECHAT_MINIPROGRAM
    ? WECHAT_AUDIO_MAX_BYTES
    : H5_AUDIO_MAX_BYTES;
}

export function audioLimitError(channel) {
  return channel === UPLOAD_CHANNEL.WECHAT_MINIPROGRAM
    ? WECHAT_AUDIO_LIMIT_ERROR
    : H5_AUDIO_LIMIT_ERROR;
}

export function channelInSubmission(record) {
  return record && Object.prototype.hasOwnProperty.call(record, 'channel')
    ? record.channel
    : null;
}