const assert = require('node:assert/strict');
const {
  DEVELOPMENT_API_BASE_URL,
  PRODUCTION_API_BASE_URL,
  apiBaseUrlForEnv,
} = require('../miniprogram/config.js');

assert.equal(apiBaseUrlForEnv('release'), PRODUCTION_API_BASE_URL);
assert.equal(apiBaseUrlForEnv('trial'), DEVELOPMENT_API_BASE_URL);
assert.equal(apiBaseUrlForEnv('develop'), DEVELOPMENT_API_BASE_URL);
assert.equal(apiBaseUrlForEnv(undefined), DEVELOPMENT_API_BASE_URL);
console.log('✓ 小程序开发/预览与正式版 API 主机选择通过');
