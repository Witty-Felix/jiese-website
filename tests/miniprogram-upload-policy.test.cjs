const assert = require('node:assert/strict');
const {
  AUDIO_MAX_BYTES,
  AUDIO_SIZE_ERROR,
  UPLOAD_CHANNEL,
  assertReadByteLength,
  validateAudioSelection,
  withUploadChannel,
} = require('../miniprogram/upload-policy.js');

assert.equal(AUDIO_MAX_BYTES, 100 * 1024 * 1024);
assert.deepEqual(validateAudioSelection({ size: AUDIO_MAX_BYTES }), { ok: true, size: AUDIO_MAX_BYTES });
assert.deepEqual(validateAudioSelection({ size: AUDIO_MAX_BYTES + 1 }), { ok: false, error: AUDIO_SIZE_ERROR });
assert.deepEqual(validateAudioSelection({ size: 0 }), { ok: false, error: '录音大小无效' });
assert.throws(() => assertReadByteLength(new ArrayBuffer(3), 4, '录音'), /录音读取字节数不一致：3\/4/);
const bytes = new ArrayBuffer(4);
assert.equal(assertReadByteLength(bytes, 4), bytes);
assert.deepEqual(withUploadChannel({ nickname: '成员甲' }), {
  nickname: '成员甲', channel: UPLOAD_CHANNEL,
});
console.log('✓ 小程序 100 MiB 前置校验、readFile 字节断言与通道标识通过');