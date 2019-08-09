// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import { Newtvim } from './Newtvim';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const newtvim = new Newtvim('/usr/local/bin/nvim');

  newtvim.start();

  context.subscriptions.push(newtvim);
}

// this method is called when your extension is deactivated
export function deactivate() {}
