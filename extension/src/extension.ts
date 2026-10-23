import * as vscode from 'vscode';

// Relay for VS Code. Its main job is to register Relay's remote MCP
// server, so Copilot agent mode (and any other MCP client inside VS Code)
// can use Relay's tools with no manual setup. VS Code runs the OAuth
// sign-in itself the first time a tool is used, so this extension stores
// no tokens or secrets.

const PROVIDER_ID = 'relay';

export function activate(context: vscode.ExtensionContext) {
  const changed = new vscode.EventEmitter<void>();

  context.subscriptions.push(
    changed,
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        const backend = getBackendUrl();
        return backend ? [new vscode.McpHttpServerDefinition('Relay', vscode.Uri.parse(`${backend}/mcp`))] : [];
      },
    }),
    // Re-announce the server when the user points the extension elsewhere.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('relay.backendUrl')) changed.fire();
    }),
    vscode.commands.registerCommand('relay.openDashboard', () => openBackendPage('/dashboard')),
    vscode.commands.registerCommand('relay.installApp', () => openBackendPage('/install'))
  );
}

export function deactivate() {}

function getBackendUrl(): string | undefined {
  const url = vscode.workspace.getConfiguration('relay').get<string>('backendUrl');
  return url ? url.replace(/\/+$/, '') : undefined;
}

async function openBackendPage(path: string) {
  const backend = getBackendUrl();
  if (!backend) {
    const choice = await vscode.window.showWarningMessage('Set "relay.backendUrl" in Settings first.', 'Open Settings');
    if (choice) await vscode.commands.executeCommand('workbench.action.openSettings', 'relay.backendUrl');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(`${backend}${path}`));
}