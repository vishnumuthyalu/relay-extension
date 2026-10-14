import * as vscode from 'vscode';

// Relay's VS Code extension. With Relay running as a GitHub App, webhooks
// are created by the app itself, so the extension no longer handles
// tokens or secrets: it just opens the right pages on your Relay backend.
// Phase 6 adds the MCP server definition and an "open dashboard" command.

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('relay.installApp', () => openBackendPage('/install')),
    vscode.commands.registerCommand('relay.signIn', () => openBackendPage('/auth/login'))
  );
}

export function deactivate() {}

function getBackendUrl(): string {
  const url = vscode.workspace.getConfiguration('relay').get<string>('backendUrl');
  if (!url) throw new Error('Set "relay.backendUrl" in Settings first.');
  return url.replace(/\/+$/, '');
}

async function openBackendPage(path: string) {
  try {
    await vscode.env.openExternal(vscode.Uri.parse(`${getBackendUrl()}${path}`));
  } catch (err) {
    vscode.window.showErrorMessage(`Relay: ${(err as Error).message}`);
  }
}