import * as vscode from "vscode";
import { ExplorerPanel } from "./webview/explorer-panel";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("springExplorer.open", () => ExplorerPanel.open(context.extensionUri)),

    // From the editor/explorer context menu (uri) or the Command Palette (active editor).
    vscode.commands.registerCommand("springExplorer.reveal", (uri?: vscode.Uri) => {
      const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      return ExplorerPanel.open(context.extensionUri, file);
    }),

    // Keep the panel's selection in sync with the active editor.
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        ExplorerPanel.revealFile(editor.document.uri.fsPath);
      }
    }),
  );
}

export function deactivate() {}
