import * as vscode from 'vscode';

const SECRET_GITHUB_TOKEN = 'relay.githubToken';
const SECRET_WEBHOOK_SECRET = 'relay.webhookSecret';
const SECRET_CONFIG_API_KEY = 'relay.configApiKey';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('relay.registerWebhook', () => registerWebhook(context)),
    vscode.commands.registerCommand('relay.setClientMapping', () => setClientMapping(context)),
    vscode.commands.registerCommand('relay.sendTestEmail', () => sendTestEmail(context)),
    vscode.commands.registerCommand('relay.resetSecrets', () => resetSecrets(context))
  );
}

export function deactivate() {}

// ---- shared helpers ----------------------------------------------------

function getBackendUrl(): string {
  const url = vscode.workspace.getConfiguration('relay').get<string>('backendUrl');
  if (!url) throw new Error('Set "relay.backendUrl" in Settings first.');
  return url.replace(/\/+$/, '');
}

// Prompts once, then caches in VS Code's encrypted SecretStorage — never
// written to settings.json, never logged.
async function getOrPromptSecret(context: vscode.ExtensionContext, key: string, prompt: string): Promise<string> {
  const existing = await context.secrets.get(key);
  if (existing) return existing;
  const value = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (!value) throw new Error(`"${prompt}" is required.`);
  await context.secrets.store(key, value);
  return value;
}

// Reads the current repo's owner/repo from VS Code's built-in Git
// extension instead of asking the user to type it — the same key the
// backend's /config route maps clients by.
interface MinimalRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}
interface MinimalGitRepo {
  rootUri: vscode.Uri;
  state: { remotes: MinimalRemote[] };
}
interface MinimalGitAPI {
  repositories: MinimalGitRepo[];
  getRepository(uri: vscode.Uri): MinimalGitRepo | null;
}
interface GitExtensionExports {
  getAPI(version: 1): MinimalGitAPI;
}

// Handles https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git),
// including repo names that contain dots (e.g. "my.site").
export function parseGithubRemote(remoteUrl: string): string | null {
  const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

// Prefer the repository that contains the file being edited (multi-root
// workspaces can hold several), then the first one VS Code knows about.
function pickRepository(git: MinimalGitAPI): MinimalGitRepo | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return (activeUri && git.getRepository(activeUri)) || git.repositories[0];
}

async function inferOwnerRepo(): Promise<string> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  const git = (await ext?.activate())?.getAPI(1);
  const repository = git && pickRepository(git);
  if (!repository) throw new Error('No Git repository found — open a folder that is a Git repo.');

  // Prefer "origin"; fall back to any remote that points at GitHub.
  const remotes = repository.state.remotes;
  const ordered = [...remotes.filter((r) => r.name === 'origin'), ...remotes.filter((r) => r.name !== 'origin')];
  for (const remote of ordered) {
    const url = remote.fetchUrl ?? remote.pushUrl;
    const ownerRepo = url && parseGithubRemote(url);
    if (ownerRepo) return ownerRepo;
  }
  throw new Error('No GitHub remote found on this repository.');
}

// ---- commands ------------------------------------------------------------

async function registerWebhook(context: vscode.ExtensionContext) {
  try {
    const repo = await inferOwnerRepo();
    const backendUrl = getBackendUrl();
    const githubToken = await getOrPromptSecret(context, SECRET_GITHUB_TOKEN, 'GitHub personal access token (admin:repo_hook scope)');
    const webhookSecret = await getOrPromptSecret(context, SECRET_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET (must match your backend's .env)");
    const hookUrl = `${backendUrl}/webhook/github`;
    const headers = {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };

    // Running the command twice must not create a second hook (which
    // would send every push twice under different delivery IDs).
    const existing = await fetch(`https://api.github.com/repos/${repo}/hooks?per_page=100`, { headers });
    if (!existing.ok) throw new Error(`GitHub API ${existing.status}: ${await existing.text()}`);
    const hooks = (await existing.json()) as { config?: { url?: string } }[];
    if (hooks.some((h) => h.config?.url === hookUrl)) {
      vscode.window.showInformationMessage(`Webhook already registered on ${repo} → ${hookUrl}`);
      return;
    }

    const res = await fetch(`https://api.github.com/repos/${repo}/hooks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push'],
        config: {
          url: hookUrl,
          content_type: 'json',
          secret: webhookSecret,
          insecure_ssl: '0',
        },
      }),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    vscode.window.showInformationMessage(`Webhook registered on ${repo} → ${hookUrl}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Relay: ${(err as Error).message}`);
  }
}

async function setClientMapping(context: vscode.ExtensionContext) {
  try {
    const repo = await inferOwnerRepo();
    const backendUrl = getBackendUrl();
    const configApiKey = await getOrPromptSecret(context, SECRET_CONFIG_API_KEY, "CONFIG_API_KEY (must match your backend's .env)");
    const clientEmail = await vscode.window.showInputBox({ prompt: 'Client email', ignoreFocusOut: true });
    const clientName = await vscode.window.showInputBox({ prompt: 'Client name', ignoreFocusOut: true });
    if (!clientEmail || !clientName) return;
    // Shape enforced by spec/openapi.yaml's ClientConfig schema (Part 2)
    const res = await fetch(`${backendUrl}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-config-key': configApiKey },
      body: JSON.stringify({ repo, clientEmail, clientName }),
    });
    if (!res.ok) throw new Error(`Backend ${res.status}: ${await res.text()}`);
    vscode.window.showInformationMessage(`Mapped ${repo} → ${clientEmail}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Relay: ${(err as Error).message}`);
  }
}

async function sendTestEmail(context: vscode.ExtensionContext) {
  try {
    const repo = await inferOwnerRepo();
    const backendUrl = getBackendUrl();
    const configApiKey = await getOrPromptSecret(context, SECRET_CONFIG_API_KEY, "CONFIG_API_KEY (must match your backend's .env)");
    const res = await fetch(`${backendUrl}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-config-key': configApiKey },
      body: JSON.stringify({ repo }),
    });
    if (res.status === 404) {
      vscode.window.showWarningMessage(`No client mapped to ${repo} yet — run "Relay: Map This Repo to a Client" first.`);
      return;
    }
    if (!res.ok) throw new Error(`Backend ${res.status}: ${await res.text()}`);
    vscode.window.showInformationMessage(`Test digest sent for ${repo}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Relay: ${(err as Error).message}`);
  }
}

// Secrets are cached after the first prompt; this clears them so a
// mistyped token or rotated key can be entered again.
async function resetSecrets(context: vscode.ExtensionContext) {
  await Promise.all(
    [SECRET_GITHUB_TOKEN, SECRET_WEBHOOK_SECRET, SECRET_CONFIG_API_KEY].map((key) => context.secrets.delete(key))
  );
  vscode.window.showInformationMessage('Relay: stored secrets cleared. You will be asked again next time.');
}
