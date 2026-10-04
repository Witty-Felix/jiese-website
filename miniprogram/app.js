const { DEFAULT_API_BASE_URL } = require('./checkin-client.js');

App({
  globalData: {
    // 小程序后台「服务器域名」需配置此主机；H5 仍继续使用 Pages 地址。
    apiBaseUrl: DEFAULT_API_BASE_URL,
  },
});
