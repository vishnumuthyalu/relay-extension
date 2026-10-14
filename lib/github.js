// The handful of GitHub calls Relay makes for "Sign in with GitHub",
// using the GitHub App's user authorization (OAuth web flow). Plain
// fetch keeps it dependency-free and easy to stub in tests.

const GITHUB = 'https://github.com';
const API = 'https://api.github.com';

function createGithubClient({ clientId, clientSecret, appSlug, fetchImpl = fetch }) {
  async function api(path, token) {
    const res = await fetchImpl(`${API}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'relay',
      },
    });
    if (!res.ok) throw new Error(`GitHub ${path} failed: ${res.status}`);
    return res.json();
  }

  return {
    installUrl: `${GITHUB}/apps/${appSlug}/installations/new`,

    authorizeUrl({ state, redirectUri }) {
      const params = new URLSearchParams({ client_id: clientId, state, redirect_uri: redirectUri });
      return `${GITHUB}/login/oauth/authorize?${params}`;
    },

    async exchangeCode({ code, redirectUri }) {
      const res = await fetchImpl(`${GITHUB}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      });
      const data = await res.json();
      if (!res.ok || !data.access_token) {
        throw new Error(`GitHub token exchange failed: ${data.error_description || data.error || res.status}`);
      }
      return data.access_token;
    },

    async getUser(token) {
      const user = await api('/user', token);
      return { githubUserId: user.id, login: user.login };
    },

    // Installations of THIS app that the signed-in user can access.
    async listInstallations(token) {
      const installations = [];
      for (let page = 1; ; page++) {
        const data = await api(`/user/installations?per_page=100&page=${page}`, token);
        for (const inst of data.installations) {
          installations.push({ id: inst.id, accountLogin: inst.account.login, accountType: inst.account.type });
        }
        if (data.installations.length < 100) return installations;
      }
    },
  };
}

module.exports = { createGithubClient };