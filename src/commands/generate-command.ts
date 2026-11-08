import * as vscode from "vscode";
import * as fs from "fs/promises";
import { JavaFile, parseJava } from "../parser/java-parser";
import { analyze } from "../analysis/spring-analyzer";
import { VscodeUtils } from "../utils/vscode-utils";
import StateUtils from "../utils/state-utils";

async function parseWorkspace(): Promise<JavaFile[]> {
  const uris = await VscodeUtils.findJavaFiles();
  const files: JavaFile[] = [];
  for (const uri of uris) {
    try {
      const source = await fs.readFile(uri.fsPath, "utf-8");
      files.push(parseJava(source, uri.fsPath));
    } catch (error) {
      console.warn(`Spring Explorer: skipped ${uri.fsPath}`, error);
    }
  }
  return files;
}

/** Scans the workspace and stores the results in StateUtils. */
export async function generateBeans(): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Spring Explorer: analyzing beans" },
    async () => {
      const files = await parseWorkspace();
      StateUtils.setResults(analyze(files));
    },
  );
}

export async function generateBeansIfNotYetExecuted(): Promise<void> {
  if (!StateUtils.hasResults()) {
    await generateBeans();
  }
}
