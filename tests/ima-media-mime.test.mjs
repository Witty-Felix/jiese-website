import assert from 'node:assert/strict';
import { createMedia } from '../functions/api/_ima.js';
const original = globalThis.fetch;
try {
  for (const [input, expected] of [['audio/mp4','audio/x-m4a'],['audio/x-wav','audio/wav'],['audio/mpeg','audio/mpeg'],['image/jpeg','image/jpeg']]) {
    let sent;
    globalThis.fetch = async (_, options) => { sent=JSON.parse(options.body); return { status:200, json:async()=>({code:0}) }; };
    await createMedia({}, {kbId:'test',fileName:'test',fileSize:1,contentType:input,fileExt:'test'});
    assert.equal(sent.content_type, expected);
    assert.equal(Object.hasOwn(sent,'media_type'), false);
  }
} finally { globalThis.fetch=original; }
console.log('ima MIME normalization contract passed');
