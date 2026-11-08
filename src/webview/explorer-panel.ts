import * as vscode from "vscode";
import * as path from "path";
import { BeanKind, BeansMap, Endpoint } from "../types/types";
import StateUtils from "../utils/state-utils";
import { generateBeans, generateBeansIfNotYetExecuted } from "../commands/generate-command";

/** Serializable snapshot sent to the webview. */
export type PanelData = {
  workspaceRoot: string;
  beans: {
    id: string;
    name: string;
    typeName: string;
    beanName: string;
    kind: BeanKind;
    file: string;
    relativeFile: string;
    line: number;
    level: number;
    used: boolean;
    entryPoint: boolean;
    primary: boolean;
    tags: string[];
    dependencies: string[];
    external: string[];
    endpoints: Endpoint[];
    declaredBy: string | null;
  }[];
};

type WebviewMessage =
  | { type: "ready" }
  | { type: "open"; file: string; line?: number }
  | { type: "refresh" };

export class ExplorerPanel {
  private static current: ExplorerPanel | undefined;
  private static readonly viewType = "springExplorer.panel";

  private readonly disposables: vscode.Disposable[] = [];
  private data: PanelData | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg), null, this.disposables);
  }

  /** Opens (or focuses) the panel, analyzing the workspace on first use. Optionally selects the bean in `file`. */
  static async open(extensionUri: vscode.Uri, file?: string): Promise<void> {
    const panel = ExplorerPanel.show(extensionUri);
    await generateBeansIfNotYetExecuted();
    panel.pushResults();
    if (file) {
      panel.reveal(file);
    }
  }

  /** Selects the bean defined in `file`, if the panel is open. */
  static revealFile(file: string): void {
    ExplorerPanel.current?.reveal(file);
  }

  private static show(extensionUri: vscode.Uri): ExplorerPanel {
    if (ExplorerPanel.current) {
      ExplorerPanel.current.panel.reveal();
      return ExplorerPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ExplorerPanel.viewType,
      "Spring Explorer",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    panel.iconPath = new vscode.ThemeIcon("type-hierarchy");
    ExplorerPanel.current = new ExplorerPanel(panel, extensionUri);
    return ExplorerPanel.current;
  }

  private pushResults(): void {
    if (!StateUtils.beans) {
      return;
    }
    this.data = ExplorerPanel.serialize(StateUtils.beans);
    this.panel.webview.postMessage({ type: "data", payload: this.data });
  }

  private reveal(file: string): void {
    this.panel.webview.postMessage({ type: "reveal", file });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        if (this.data) {
          this.panel.webview.postMessage({ type: "data", payload: this.data });
        }
        return;
      case "open": {
        const position = new vscode.Position(Math.max((msg.line ?? 1) - 1, 0), 0);
        await vscode.window.showTextDocument(vscode.Uri.file(msg.file), {
          viewColumn: vscode.ViewColumn.Beside,
          preview: true,
          selection: msg.line ? new vscode.Range(position, position) : undefined,
        });
        return;
      }
      case "refresh":
        this.panel.webview.postMessage({ type: "loading" });
        await generateBeans();
        this.pushResults();
        return;
    }
  }

  private static serialize(beans: BeansMap): PanelData {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const relative = (file: string) => (workspaceRoot ? path.relative(workspaceRoot, file) : file).replace(/\\/g, "/");

    return {
      workspaceRoot,
      beans: Array.from(beans.values()).map(b => ({
        id: b.id,
        name: b.name,
        typeName: b.typeName,
        beanName: b.beanName,
        kind: b.kind,
        file: b.file,
        relativeFile: relative(b.file),
        line: b.line,
        level: b.level,
        used: b.used,
        entryPoint: b.entryPoint,
        primary: b.primary,
        tags: b.tags,
        dependencies: b.dependencies.map(d => d.id),
        external: b.external,
        endpoints: b.endpoints,
        declaredBy: b.declaredBy?.id ?? null,
      })),
    };
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media("panel.css")}">
  <title>Spring Explorer</title>
</head>
<body>
  <header class="toolbar">
    <div class="segmented" role="tablist" aria-label="View">
      <button class="tab active" data-view="board" role="tab">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h3v11H2zM6.5 2.5h3v7h-3zM11 2.5h3v9h-3z"/></svg>Board
      </button>
      <button class="tab" data-view="hierarchy" role="tab">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h5v3.5H2zM6 10.5h5V14H6zM4 5.5v6.5h2v-1H5V5.5zM9 6.25h5v3.5H9zM4.5 8.5H9v-1H4.5z"/></svg>Hierarchy
      </button>
      <button class="tab" data-view="endpoints" role="tab">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm4.9 6H10.6a10 10 0 0 0-.9-4.3 5 5 0 0 1 3.2 4.3zM8 3c.5.6 1.1 2.2 1.2 4.5H6.8C6.9 5.2 7.5 3.6 8 3zM6.3 3.2a10 10 0 0 0-.9 4.3H3.1a5 5 0 0 1 3.2-4.3zM3.1 8.5h2.3c.1 1.7.4 3.2.9 4.3a5 5 0 0 1-3.2-4.3zM8 13c-.5-.6-1.1-2.2-1.2-4.5h2.4C9.1 10.8 8.5 12.4 8 13zm1.7-.2c.5-1.1.8-2.6.9-4.3h2.3a5 5 0 0 1-3.2 4.3z"/></svg>Endpoints
      </button>
    </div>
    <div class="search">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.7 9.6a5 5 0 1 0-1.1 1.1l3.6 3.6 1.1-1.1zM6.7 10.2a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>
      <input id="search" type="search" placeholder="Filter by name" aria-label="Filter by name" spellcheck="false">
    </div>
    <button id="unused-toggle" class="toggle-chip" aria-pressed="false" title="Show only services, components, repositories, mappers and clients that no project bean injects">
      Unused <span id="unused-count" class="count-pill">0</span>
    </button>
    <span id="stats" class="stats"></span>
    <button id="refresh" class="icon-button" title="Re-analyze workspace" aria-label="Re-analyze workspace">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 2.5v4h-4l1.5-1.5a4.5 4.5 0 1 0 1.3 4.2l1.5.3A6 6 0 1 1 12.1 4z"/></svg>
    </button>
  </header>
  <div class="layout">
    <main id="content" class="content"><div class="empty"><div class="spinner"></div>Analyzing workspace…</div></main>
    <aside id="details" class="details hidden" aria-label="Bean details"></aside>
  </div>
  <script nonce="${nonce}" src="${media("panel.js")}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    ExplorerPanel.current = undefined;
    this.disposables.forEach(d => d.dispose());
  }
}
