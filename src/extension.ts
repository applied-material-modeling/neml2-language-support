// Licensed under LGPL 2.1, please see LICENSE for details
// https://www.gnu.org/licenses/lgpl-2.1.html

import * as fs from 'fs';
import * as process from 'process';
import {
	window,
	commands,
	workspace,
	ExtensionContext,
	QuickPickItem,
	QuickPickItemKind,
	Uri,
	TextDocument
} from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions
} from 'vscode-languageclient/node';

let client: LanguageClient | null = null;
let doc: TextDocument | null = null;
let ctx: ExtensionContext;

const RECENT_CHOICES_KEY = 'neml2_language_server_recent_choices';
const MAX_RECENT_CHOICES = 5;

// The NEML2 language server picked by the user last time
// undefined: the user hasn't made a choice yet, and so the selector will be shown
// null: the user opted out of language features
let server_path: string | null | undefined = undefined;

function try_start() {
	if (!client) { return; }

	client.start()
		.then(() => { /* maybe show a running indicator */ })
		.catch(() => {
			window.showErrorMessage("Failed to start NEML2 language server.");
			client = null;
			server_path = null;
		});
}

function get_recent_choices(): string[] {
	return ctx.globalState.get<string[]>(RECENT_CHOICES_KEY) || [];
}

function update_recent_choices(choice: string) {
	let choices = get_recent_choices();
	choices = [choice, ...choices.filter(c => c !== choice)];
	if (choices.length > MAX_RECENT_CHOICES) {
		choices = choices.slice(0, MAX_RECENT_CHOICES);
	}
	ctx.globalState.update(RECENT_CHOICES_KEY, choices);
}

async function pick_server(): Promise<string | null | undefined> {
	if (!doc) { return undefined; }

	// env var
	const env_var = 'NEML2_LANGUAGE_SERVER';
	if (env_var in process.env) {
		return process.env[env_var];
	}

	// user opted out of autocomplete for now
	if (server_path === null) {
		window.showInformationMessage("NEML2 Language Server disabled.");
		return null;
	}

	// prompt user to pick an executable
	if (server_path === undefined) {
		// find server_candidates (up the path)
		let server_candidates = new Map<Date, QuickPickItem>();
		let uri = doc.uri;

		// we might have an "untitled" editor (an non existing file that was opend using the command line)
		// let's just drop the `untitled:` scheme and hope for the best. In the worst case the user can still
		// manually select an executable (or use one from the list of recent ones).
		if (uri.scheme === 'untitled') {
			uri = uri.with({ scheme: 'file' });
		}

		while (true) {
			// keep searching in the parent dir
			let newuri = Uri.joinPath(uri, "..");
			if (newuri === uri) { break; }
			uri = newuri;
			// look for `langserv` in the current directory
			for (const [name, type] of await workspace.fs.readDirectory(uri)) {
				if (name === "langserv") {
					let fileuri = Uri.joinPath(uri, name);
					let p = fileuri.fsPath;
					try {
						// check if p is executable
						fs.accessSync(p, fs.constants.X_OK);
						// get modification time
						server_candidates.set(fs.statSync(p).mtime, {
							label: p,
							detail: 'Last updated ' + fs.statSync(p).mtime.toLocaleString()
						});
					} catch (err) {
						continue;
					}
				}
			}
		}

		// no server candidate found
		if (server_candidates.size === 0) {
			window.showInformationMessage("No NEML2 language server found in the current directory or any of the parent directories.");
			return null;
		}

		// sort by modification time
		let server_candidates_sorted = new Map([...server_candidates.entries()].sort());

		// build quick pick items
		let items: QuickPickItem[] = [...server_candidates_sorted.values()];
		items = items.concat([{
			label: 'Other options...',
			kind: QuickPickItemKind.Separator
		},
		{
			label: "Open File...",
			detail: 'Manually select the language server'
		}]);
		const recent = get_recent_choices();
		if (recent.length > 0) {
			items.push({
				label: 'Recently used language servers',
				kind: QuickPickItemKind.Separator
			});
			items = items.concat(recent.map(name => ({ label: name })));
		}

		// prompt the user to pick a server
		const server_pick = await window.showQuickPick(items, { placeHolder: 'NEML2 language server' });

		// no selection
		if (!server_pick) { return undefined; }

		// user wants to manually select a server
		if (server_pick.label === 'Open File...') {
			const selection = await window.showOpenDialog({
				canSelectFiles: true,
				canSelectMany: false,
				filters: {}
			});

			if (selection && selection[0]) {
				return selection[0].fsPath;
			}
			else {
				return undefined;
			}
		}

		// otherwise return the selected server
		return server_pick.label;
	}

	// otherwise return the last selected server
	return server_path;
}

async function restart_server() {
	server_path = await pick_server();
	if (!server_path) { return; }
	update_recent_choices(server_path);

	// build server options
	const serverOptions: ServerOptions = {
		command: server_path
	};

	// options to control the language client
	const clientOptions: LanguageClientOptions = {
		// register the server for NEML2 input files
		documentSelector: [{ scheme: 'file', language: 'neml2' }, { scheme: 'untitled', language: 'neml2' }]
	};

	// create the language client and start the client.
	client = new LanguageClient(
		'language-server-neml2',
		'NEML2 Language Server',
		serverOptions,
		clientOptions
	);

	// handle notifications
	client.onNotification("neml2/debug", (msg: string) => { console.log(msg); });

	// start the client (This will also launch the server.)
	try_start();
}

export async function activate(context: ExtensionContext) {
	let editor = window.activeTextEditor;
	if (editor) {
		doc = editor.document;
	}
	ctx = context;
	restart_server();

	// If no server is running yet and we switch to a new NEML2 input, we offer the choice again
	window.onDidChangeActiveTextEditor(editor => {
		if (!editor) {
			editor = window.activeTextEditor;
			if (!editor) { return; }
		}
		if (doc === editor.document) { return; }

		if (editor.document.languageId === 'neml2') {
			doc = editor.document;
			if (!client) { restart_server(); }
		}
	});

	// add command (this should match the declaration in package.json)
	context.subscriptions.push(commands.registerCommand('neml2-language-support.start-server', async () => {
		server_path = undefined;
		if (client) {
			client.stop().then(() => { client = null; restart_server(); });
		}
		else {
			restart_server();
		}
	}));

	// update language specific configuration
	const config = workspace.getConfiguration("", { languageId: "neml2" });
	config.update("outline.showProperties", false, false, true);
	config.update("outline.showStrings", false, false, true);
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) { return undefined; }
	return client.stop();
}
