import { AuthError } from './error.mjs';

export const callbackPath = '/api/auth/callback';

export function createWechatProvider({ appId, secret, redirectUri }, fetcher = fetch) {
  return {
    authorizationUrl({ state }) {
      const url = new URL('https://open.weixin.qq.com/connect/oauth2/authorize');
      url.search = new URLSearchParams({
        appid: appId, redirect_uri: redirectUri, response_type: 'code', scope: 'snsapi_base', state,
      }).toString();
      url.hash = 'wechat_redirect';
      return url.href;
    },
    async exchange(code) {
      const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
      url.search = new URLSearchParams({ appid: appId, secret, code, grant_type: 'authorization_code' }).toString();
      let result;
      try {
        const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (response.ok) result = await response.json();
      } catch {
        // The exchange URL carries a secret and must never be included in an error or log.
      }
      if (result?.errcode || typeof result?.openid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.openid)) {
        throw new AuthError('OAUTH_PROVIDER', '微信授权失败，请返回活动首页重试。', 502);
      }
      return result.openid;
    },
  };
}

const mockAccount = /^[a-zA-Z0-9_-]{1,48}$/;

export function createMockProvider() {
  return {
    authorizationUrl({ state, account }) {
      if (!mockAccount.test(account)) throw new AuthError('OAUTH_CALLBACK', '模拟账号无效。');
      return `${callbackPath}?${new URLSearchParams({ code: account, state })}`;
    },
    async exchange(code) {
      if (!mockAccount.test(code)) throw new AuthError('OAUTH_CALLBACK', '模拟授权无效。');
      return `mock:${code}`;
    },
  };
}
