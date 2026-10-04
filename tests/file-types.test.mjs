import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('const FILE_TYPES =');
const end = source.indexOf('function bindFilebox(', start);
assert(start >= 0 && end > start);
const uploadType = vm.runInNewContext(`${source.slice(start, end)}; uploadType`);
const sample = (name, type) => ({ name, type, size: 1024 });
assert.equal(uploadType(sample('reading.m4a', ''), 'audio'), 'audio/mp4');
assert.equal(uploadType(sample('reading.m4a', 'application/octet-stream'), 'audio'), 'audio/mp4');
assert.equal(uploadType(sample('reading.m4a', 'audio/x-m4a'), 'audio'), 'audio/x-m4a');
assert.equal(uploadType(sample('reading.jpg', 'image/jpeg'), 'image'), 'image/jpeg');
assert.equal(uploadType(sample('reading.mp3', 'audio/mp4'), 'audio'), null);
assert.equal(uploadType(sample('reading.txt', 'audio/mp4'), 'audio'), null);
assert.equal(uploadType(sample('reading.gif', 'image/gif'), 'image'), null);
console.log('✓ 缺失 MIME 按扩展名补报且与 prepare 白名单一致；冲突类型被拒');
