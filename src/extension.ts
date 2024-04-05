'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as cp from 'child_process';

let fzfTerminal: vscode.Terminal | undefined = undefined;
let fzfTerminalPwd: vscode.Terminal | undefined = undefined;
let findCmd: string | undefined;
let fzfCmd: string | undefined;
let initialCwd: string | undefined;
let rgFlags: string;
let fzfPipe: string | undefined;
let fzfPipeScript: string | undefined;
let windowsNeedsEscape: boolean = false;
let fzfQuote: string = "'";

const workspaceFolder: string | undefined = getWorkSpaceFolder();
const gitTopLevelDirectoryCmd_Win32: string = "cd ${workspaceFolder}";
const gitTopLevelDirectoryCmd_Unix: string = "cd $(git rev-parse --show-toplevel)";

export const TERMINAL_NAME: string = "fzf terminal";
export const TERMINAL_NAME_PWD: string = "fzf terminal";
export enum rgoptions {
	CaseSensitive = "Case sensitive",
	IgnoreCase = "Ignore case",
	SmartCase = "Smart case"
}

export const rgflagmap: Map<rgoptions, string> = new Map([
	[rgoptions.CaseSensitive, "--case-sensitive"],
	[rgoptions.IgnoreCase, "--ignore-case"],
	[rgoptions.SmartCase, "--smart-case"]
]);

function showFzfTerminal(name: string, fzfTerminal: vscode.Terminal | undefined): vscode.Terminal {
	if (!fzfTerminal) {
		fzfTerminal = vscode.window.terminals.find((term) => term.name === name);
	}
	if (!fzfTerminal) {
		if (!initialCwd) {
			initialCwd = workspaceFolder || '';
		}
		fzfTerminal = vscode.window.createTerminal({
			cwd: initialCwd,
			name: name
		});
	}
	fzfTerminal.show();
	return fzfTerminal;
}

function getWorkSpaceFolder(): string | undefined {
	let path: string | undefined;
	if (!vscode.workspace.workspaceFolders) {
		path = workspace.rootPath;
	} else {
		let root: vscode.WorkspaceFolder | undefined;
		if (vscode.workspace.workspaceFolders.length === 1) {
			root = vscode.workspace.workspaceFolders[0];
		}
		path = root ? root.uri.fsPath : undefined;
	}
	return path;
}

function moveToPwd(term: vscode.Terminal): void {
	if (vscode.window.activeTextEditor) {
		let cwd = path.dirname(vscode.window.activeTextEditor.document.fileName);
		term.sendText(`cd ${cwd}`);
	}
}

function applyConfig(): void {
	let cfg = vscode.workspace.getConfiguration('fzf-quick-open');
	fzfCmd = cfg.get('fuzzyCmd') || "fzf";
	findCmd = cfg.get('findDirectoriesCmd');
	initialCwd = cfg.get('initialWorkingDirectory');
	let rgopt = <rgoptions>cfg.get('ripgrepSearchStyle');
	rgFlags = (rgflagmap.get(rgopt) || "--case-sensitive") + ' ';
	rgFlags += cfg.get('ripgrepOptions') || "";
	rgFlags = rgFlags.trim();

	if (isWindows()) {
		let term = <string>vscode.workspace.getConfiguration('terminal.integrated.shell').get('windows');
		if (!term) {
			let defaultTerm = <string>vscode.workspace.getConfiguration('terminal.integrated.defaultProfile').get('windows');
			if (!!defaultTerm) {
				let profiles = vscode.workspace.getConfiguration('terminal.integrated.profiles').get('windows');
				term = profiles?.[defaultTerm]?.path[0];
			}
		}
		let isWindowsCmd: boolean = ((term?.toLowerCase().endsWith("cmd.exe")) || (term?.toLowerCase().endsWith("powershell.exe"))) || false;
		windowsNeedsEscape = !isWindowsCmd;
		fzfQuote = isWindowsCmd ? '"' : "'";
	}
}

function isWindows(): boolean {
	return process.platform === 'win32';
}

function getPath(arg: string, pwd: string): string | undefined {
	if (!path.isAbsolute(arg)) {
		arg = path.join(pwd, arg);
	}
	if (fs.existsSync(arg)) {
		return arg;
	} else {
		return undefined;
	}
}

function escapeWinPath(origPath: string): string {
	if (isWindows() && windowsNeedsEscape) {
		return origPath.replace(/\\/g, '\\\\');
	} else {
		return origPath;
	}
}

function getFzfCmd(): string {
	return fzfCmd;
}

function getCodeOpenFileCmd(): string {
	return `${getFzfCmd()} | ${getFzfPipeScript()} open ${getFzfPipe()}`;
}

function getCodeOpenFolderCmd(): string {
	return `${getFzfCmd()} | ${getFzfPipeScript()} add ${getFzfPipe()}`;
}

function getFindCmd(): string | undefined {
	return findCmd;
}

function getFzfPipe(): string | undefined {
	let res: string | undefined = fzfPipe;
	if (res) {
		res = escapeWinPath(res);
	}
	return res;
}

function getFzfPipeScript(): string {
	return escapeWinPath(fzfPipeScript);
}

function getQuote(): string {
	return fzfQuote;
}

function processCommandInput(data: Buffer): void {
	let [cmd, pwd, arg] = data.toString().trim().split('$$');
	cmd = cmd.trim();
	pwd = pwd.trim();
	arg = arg.trim();

	if (arg === "") {
		return;
	}

	if (cmd === 'open') {
		let filename = getPath(arg, pwd);
		if (!filename) {
			return;
		}
		vscode.window.showTextDocument(vscode.Uri.file(filename));
	} else if (cmd === 'add') {
		let folder = getPath(arg, pwd);
		if (!folder) {
			return;
		}
		vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, null, {
			uri: vscode.Uri.file(folder)
		});
		vscode.commands.executeCommand('workbench.view.explorer');
	} else if (cmd === 'rg') {
		let [file, linestr, colstr] = arg.split(':');
		let filename = getPath(file, pwd);
		if (!filename) {
			return;
		}
		let line = parseInt(linestr) - 1;
		let col = parseInt(colstr) - 1;
		vscode.window.showTextDocument(vscode.Uri.file(filename)).then((ed) => {
			let start = new vscode.Position(line, col);
			ed.selection = new vscode.Selection(start, start);
			ed.revealRange(new vscode.Range(start, start));
		});
	}
}

function listenToFifo(fifo: string): void {
	fs.open(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK, (err, fd) => {
		const pipe = new net.Socket({ fd: fd, allowHalfOpen: true });
		pipe.on('data', (data) => {
			processCommandInput(data);
		});
		pipe.on('end', () => {
			listenToFifo(fifo);
		});
	});
}

function setupWindowsPipe(): void {
	let server = net.createServer((socket) => {
		socket.on('data', (data) => {
			processCommandInput(data);
		});
	});

	let idx = 0;
	while (!fzfPipe) {
		try {
			let pipe = `\\\\?\\pipe\\fzf-pipe-${process.pid}`;
			if (idx > 0) {
				pipe += `-${idx}`;
			}
			server.listen(pipe);
			fzfPipe = pipe;
		} catch (e) {
			if (e.code === 'EADDRINUSE') {
				++idx;
			} else {
				throw e;
			}
		}
	}
}

function setupPOSIXPipe(): void {
	let idx = 0;
	while (!fzfPipe && idx < 10) {
		try {
			let pipe = path.join(os.tmpdir(), `fzf-pipe-${process.pid}`);
			if (idx > 0) {
				pipe += `-${idx}`;
			}
			cp.execSync(`mkfifo -m 600 ${pipe}`);
			fzfPipe = pipe;
		} catch (e) {
			++idx;
		}
	}
	listenToFifo(fzfPipe);
}

function setupPipesAndListeners(): void {
	if (isWindows()) {
		setupWindowsPipe();
	} else {
		setupPOSIXPipe();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	applyConfig();
	setupPipesAndListeners();
	fzfPipeScript = vscode.extensions.getExtension('rlivings39.fzf-quick-open')?.extensionPath || "";
	fzfPipeScript = path.join(fzfPipeScript, 'scripts', 'topipe.' + (isWindows() ? "ps1" : "sh"));

	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('fzf-quick-open') || e.affectsConfiguration('terminal.integrated.shell.windows')) {
			applyConfig();
		}
	}
}
