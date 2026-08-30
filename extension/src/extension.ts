import * as vscode from 'vscode';

const SECRET_GITHUB_TOKEN = 'relay.githubToken';
const SECRET_WEBHOOK_SECRET = 'relay.webhookSecret';
const SECRET_CONFIG_API_KEY = 'relay.configApiKey';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('relay.registerWebhook', () => registerWebhook(context)),
    vscode.commands.registerCommand('relay.setClientMapping', () => setClientMapping(context)),
    vscode.commands.registerCommand('relay.sendTestEmail', () => sendTestEmail(context))
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
// backend's /config route (Part 4) maps clients by.
interface MinimalGitRepo {
  state: { remotes: { fetchUrl?: string; pushUrl?: string }[] };
}
interface MinimalGitAPI {
  repositories: MinimalGitRepo[];
}
interface GitExtensionExports {
  getAPI(version: 1): MinimalGitAPI;
}

async function inferOwnerRepo(): Promise<string> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  const git = (await ext?.activate())?.getAPI(1);
  const remotes = git?.repositories[0]?.state.remotes[0];
  const remoteUrl = remotes?.fetchUrl ?? remotes?.pushUrl;
  if (!remoteUrl) throw new Error('No git remote found — open a folder with a GitHub remote configured.');
  // Handles both "https://github.com/owner/repo.git" and "git@github.com:owner/repo.git"
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/);
  if (!match) throw new Error(`Could not parse an owner/repo from remote: ${remoteUrl}`);
  return `${match[1]}/${match[2]}`;
}

// ---- commands ------------------------------------------------------------

async function registerWebhook(context: vscode.ExtensionContext) {
  try {
    const repo = await inferOwnerRepo();
    const backendUrl = getBackendUrl();
    const githubToken = await getOrPromptSecret(context, SECRET_GITHUB_TOKEN, 'GitHub personal access token (admin:repo_hook scope)');
    const webhookSecret = await getOrPromptSecret(context, SECRET_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET (must match your backend's .env)");
    const res = await fetch(`https://api.github.com/repos/${repo}/hooks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push'],
        config: {
          url: `${backendUrl}/webhook/github`,
          content_type: 'json',
          secret: webhookSecret,
          insecure_ssl: '0',
        },
      }),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    vscode.window.showInformationMessage(`Webhook registered on ${repo} → ${backendUrl}/webhook/github`);
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
