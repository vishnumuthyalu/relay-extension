// GitHub context for a push: the pull request(s) the head commit came from
// and how much changed. Read with the app's installation token, so it
// needs "Pull requests: read" and "Contents: read". Everything here is
// best-effort: callers treat failures as "no extra context".

const EMPTY_SHA = /^0+$/;
const clip = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text || '');

async function githubContext({ githubApp, installationId, repo, before, after }) {
  const context = { pullRequests: [], changes: null };
  if (!after || EMPTY_SHA.test(after)) return context;

  // Merged PRs that contain the head commit: their titles and descriptions
  // usually explain the "why" far better than commit messages.
  const pulls = await githubApp.get(installationId, `/repos/${repo}/commits/${after}/pulls`);
  context.pullRequests = pulls.slice(0, 3).map((pr) => ({
    number: pr.number,
    title: clip(pr.title, 200),
    body: clip(pr.body, 800),
  }));

  // One compare call covers every commit in the push. A new branch has an
  // all-zero "before", so there's nothing to compare against.
  if (before && !EMPTY_SHA.test(before)) {
    const compare = await githubApp.get(installationId, `/repos/${repo}/compare/${before}...${after}`);
    const files = compare.files || [];
    context.changes = {
      files: files.length,
      additions: files.reduce((n, f) => n + (f.additions || 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions || 0), 0),
      busiest: [...files].sort((a, b) => (b.changes || 0) - (a.changes || 0)).slice(0, 5).map((f) => f.filename),
    };
  }
  return context;
}

function formatGithubContext({ pullRequests, changes }) {
  const lines = [];
  for (const pr of pullRequests) {
    lines.push(`Pull request #${pr.number}: ${pr.title}`);
    if (pr.body) lines.push(pr.body.replace(/\s+/g, ' ').trim());
  }
  if (changes) {
    lines.push(`Changed ${changes.files} files (+${changes.additions} / -${changes.deletions}). Most-changed: ${changes.busiest.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { githubContext, formatGithubContext };