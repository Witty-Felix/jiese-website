const PRODUCTION_API_BASE_URL = 'https://api.324614917.xyz';
const DEVELOPMENT_API_BASE_URL = 'https://jiese-checkin.pages.dev';

function apiBaseUrlForEnv(envVersion) {
  return envVersion === 'release' ? PRODUCTION_API_BASE_URL : DEVELOPMENT_API_BASE_URL;
}

module.exports = {
  DEVELOPMENT_API_BASE_URL,
  PRODUCTION_API_BASE_URL,
  apiBaseUrlForEnv,
};
