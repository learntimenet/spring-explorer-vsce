import * as vscode from "vscode";

const foldersToExclude = "**/{node_modules,target,build,out,bin,.gradle,.mvn,.idea,.git,generated,generated-sources}/**";

export class VscodeUtils {

  /** Main-source Java files of the workspace (tests excluded). */
  static async findJavaFiles(): Promise<vscode.Uri[]> {
    const files = await vscode.workspace.findFiles("**/*.java", foldersToExclude);
    return files.filter(file => !/[\\/]src[\\/](test|it|integrationTest|testFixtures)[\\/]/.test(file.fsPath));
  }

}
