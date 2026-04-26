// OpenVSCode Mobile Runtime Bridge.
//
// Spawns a localhost HTTP server inside the VS Code extension host so that the
// companion Go server (server/internal/bridge) can forward requests for git,
// diagnostics, and workspace queries into the live extension host. The Flutter
// client never talks to this server directly; the Go relay does.
//
// Zero runtime dependencies: only Node built-ins plus the `vscode` module that
// is passed in from extension.js. This file can be syntax-checked stand-alone
// with `node -c main.js` because the vscode module is injected, not required.
//
// Authentication: every request must carry `Authorization: Bearer <token>`
// matching the random token written into the runtime-info JSON at activation
// time. The Go bridge client reads that file and copies the token into each
// outbound request.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let state = null;

function activate(context, vscode) {
	if (state) {
		return; // already activated
	}

	const token = crypto.randomBytes(32).toString('hex');
	const runtimeInfoPath = resolveRuntimeInfoPath();
	const startedAt = new Date().toISOString();

	// Process-wide event broker. Subscribers register a `write(name, payload)`
	// callback; emit() fans out to all of them. The /events SSE handler holds
	// one subscription per open connection.
	const broker = createEventBroker();

	const server = http.createServer((req, res) => {
		handleRequest(req, res, vscode, token, broker, startedAt).catch((err) => {
			respondError(res, 500, 'internal_error', err && err.message ? err.message : String(err));
		});
	});

	// Bind to loopback only. Port 0 = let the OS pick an available port.
	server.listen(0, '127.0.0.1', () => {
		const address = server.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		try {
			writeRuntimeInfo(runtimeInfoPath, {
				host: '127.0.0.1',
				port,
				token,
				pid: process.pid,
				startedAt: new Date().toISOString(),
				version: 1,
			});
			console.log(`[openvsmobile-bridge] listening on 127.0.0.1:${port}`);
		} catch (err) {
			console.error(`[openvsmobile-bridge] failed to write runtime info: ${err}`);
		}
	});

	server.on('error', (err) => {
		console.error(`[openvsmobile-bridge] server error: ${err}`);
	});

	const eventDisposables = subscribeVSCodeEvents(vscode, broker);

	state = { server, runtimeInfoPath, broker, eventDisposables };

	context.subscriptions.push({
		dispose() {
			deactivate();
		},
	});
}

function deactivate() {
	if (!state) {
		return;
	}
	const { server, runtimeInfoPath, broker, eventDisposables } = state;
	state = null;
	if (Array.isArray(eventDisposables)) {
		for (const d of eventDisposables) {
			try {
				d.dispose();
			} catch (_err) {
				// best-effort
			}
		}
	}
	if (broker) {
		broker.shutdown();
	}
	try {
		fs.unlinkSync(runtimeInfoPath);
	} catch (_err) {
		// best-effort cleanup
	}
	if (server) {
		server.close();
	}
}

function resolveRuntimeInfoPath() {
	const override = process.env.OPENVSCODE_MOBILE_BRIDGE_INFO_PATH;
	if (override) {
		return override;
	}
	const home = os.homedir();
	return path.join(home, '.config', 'openvscode-mobile', 'bridge-runtime.json');
}

function writeRuntimeInfo(target, info) {
	const dir = path.dirname(target);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, target);
}

async function handleRequest(req, res, vscode, expectedToken, broker, startedAt) {
	const auth = req.headers['authorization'] || '';
	if (auth !== `Bearer ${expectedToken}`) {
		return respondError(res, 401, 'unauthorized', 'invalid bearer token');
	}

	const url = new URL(req.url, 'http://127.0.0.1');
	const route = `${req.method} ${url.pathname}`;

	switch (route) {
		case 'GET /healthz':
			return respondJSON(res, 200, { status: 'ok' });

		// Server-Sent Events stream — long-lived, never closes from server side.
		case 'GET /events':
			return handleEvents(req, res, broker, startedAt);

		// Git endpoints — delegate to the built-in git extension's bridge commands.
		case 'GET /git/repository':
			return handleGitRepository(res, url, vscode);
		case 'GET /git/diff':
			return handleGitDiff(res, url, vscode);
		case 'POST /git/stage':
			return handleGitFileCommand(req, res, vscode, 'git.bridge.stage', true);
		case 'POST /git/unstage':
			return handleGitFileCommand(req, res, vscode, 'git.bridge.unstage', true);
		case 'POST /git/discard':
			return handleGitFileCommand(req, res, vscode, 'git.bridge.discard', true);
		case 'POST /git/commit':
			return handleGitCommit(req, res, vscode);
		case 'POST /git/checkout':
			return handleGitCheckout(req, res, vscode);
		case 'POST /git/fetch':
			return handleGitRemoteCommand(req, res, vscode, 'git.bridge.fetch', false);
		case 'POST /git/pull':
			return handleGitRemoteCommand(req, res, vscode, 'git.bridge.pull', false);
		case 'POST /git/push':
			return handleGitRemoteCommand(req, res, vscode, 'git.bridge.push', true);
		case 'POST /git/stash':
			return handleGitStash(req, res, vscode);
		case 'POST /git/stash/apply':
			return handleGitStashApply(req, res, vscode);

		// Diagnostics endpoint — reads from the live language servers.
		case 'GET /diagnostics':
			return handleDiagnostics(res, url, vscode);

		// Workspace queries.
		case 'GET /workspace/folders':
			return handleWorkspaceFolders(res, vscode);
		case 'GET /workspace/findFiles':
			return handleFindFiles(res, url, vscode);
		case 'GET /workspace/findText':
			return handleFindText(res, url, vscode);
	}

	return respondError(res, 404, 'not_found', `no route for ${route}`);
}

// --- git handlers ----------------------------------------------------------

async function handleGitRepository(res, url, vscode) {
	const path = requireQuery(res, url, 'path');
	if (path === null) {
		return;
	}
	try {
		const state = await vscode.commands.executeCommand('git.bridge.getRepositoryState', path);
		respondJSON(res, 200, state);
	} catch (err) {
		respondError(res, 502, 'git_command_failed', errorMessage(err));
	}
}

async function handleGitDiff(res, url, vscode) {
	const repo = requireQuery(res, url, 'path');
	if (repo === null) {
		return;
	}
	const file = url.searchParams.get('file') || '';
	const staged = url.searchParams.get('staged') === 'true';
	if (!file) {
		return respondError(res, 400, 'invalid_request', 'file query parameter is required');
	}
	try {
		const result = await vscode.commands.executeCommand('git.bridge.diffRepository', repo, file, staged);
		respondJSON(res, 200, result);
	} catch (err) {
		respondError(res, 502, 'git_command_failed', errorMessage(err));
	}
}

async function handleGitFileCommand(req, res, vscode, command, requireFiles) {
	const body = await readJSONBody(req, res);
	if (body === null) {
		return;
	}
	if (!body.path || typeof body.path !== 'string') {
		return respondError(res, 400, 'invalid_request', 'path is required');
	}
	const files = collectFiles(body);
	if (requireFiles && files.length === 0) {
		return respondError(res, 400, 'invalid_request', 'at least one file is required');
	}
	try {
		const state = await vscode.commands.executeCommand(command, body.path, files);
		respondJSON(res, 200, state);
	} catch (err) {
		respondError(res, 502, 'git_command_failed', errorMessage(err));
	}
}

async function handleGitCommit(req, res, vscode) {
	const body = await readJSONBody(req, res);
	if (body === null) {
		return;
	}
	if (!body.path || !body.message) {
		return respondError(res, 400, 'invalid_request', 'path and message are required');
	}
	try {
		const state = await vscode.commands.executeCommand('git.bridge.commit', body.path, body.message);
		respondJSON(res, 200, state);
	} catch (err) {
		respondError(res, 502, 'git_command_failed', errorMessage(err));
	}
}

async function handleGitCheckout(req, res, vscode) {
	const body = await readJSONBody(req, res);
	if (body === null) {
		return;
	}
	if (!body.path) {
		return respondError(res, 400, 'invalid_request', 'path is required');
	}
	const ref = body.ref || body.branch;
	if (!ref) {
		return respondError(res, 400, 'invalid_request', 'ref or branch is required');
	}
	try {
		const state = await vscode.commands.executeCommand('git.bridge.checkout', body.path, ref, !!body.create);
		respondJSON(res, 200, state);
	} catch (err) {
		respondError(res, 502, 'git_command_failed', errorMessage(err));
	}
}

async function handleGitRemoteCommand(req, res, vscode, command, allowSetUpstream) {
	const body = await readJSONBody(req, res);
	if (body === null) {
		return;
	}
	if (!body.path) {
		return respondError(res, 400, 'invalid_request', 'path is required');
	}
	try {
		const args = [body.path, body.remote || undefined, body.branch || undefined];
		if (allowSetUpstream) {
			args.push(!!body.setUpstream);
		}
		const state = await vscode.commands.executeCommand(command, ...args);
		respondJSON(res, 200, state);
	} catch (err) {
		respondError(res, 502, 'git_command_failed', errorMessage(err));
	}
}

async function handleGitStash(req, res, vscode) {
	const body = await readJSONBody(req, res);
	if (body === null) {
		return;
	}
	if (!body.path) {
		return respondError(res, 400, 'invalid_request', 'path is required');
	}
	try {
		const state = await vscode.commands.executeCommand('git.bridge.stash', body.path, body.message || undefined, !!body.includeUntracked);
		respondJSON(res, 200, state);
	} catch (err) {
		respondError(res, 502, 'git_command_failed', errorMessage(err));
	}
}

async function handleGitStashApply(req, res, vscode) {
	const body = await readJSONBody(req, res);
	if (body === null) {
		return;
	}
	if (!body.path) {
		return respondError(res, 400, 'invalid_request', 'path is required');
	}
	try {
		const state = await vscode.commands.executeCommand('git.bridge.stashApply', body.path, body.stash || undefined, !!body.pop);
		respondJSON(res, 200, state);
	} catch (err) {
		respondError(res, 502, 'git_command_failed', errorMessage(err));
	}
}

function collectFiles(body) {
	const files = [];
	if (typeof body.file === 'string' && body.file !== '') {
		files.push(body.file);
	}
	if (Array.isArray(body.files)) {
		for (const f of body.files) {
			if (typeof f === 'string' && f !== '') {
				files.push(f);
			}
		}
	}
	return files;
}

// --- diagnostics handler ---------------------------------------------------

async function handleDiagnostics(res, url, vscode) {
	const filter = url.searchParams.get('path') || '';
	const workDir = url.searchParams.get('workDir') || '';
	const all = vscode.languages.getDiagnostics();
	// `all` is Iterable<[Uri, Diagnostic[]]>.
	const out = [];
	for (const entry of all) {
		const uri = entry[0];
		const diags = entry[1];
		const fsPath = uri.fsPath;
		if (filter && fsPath !== filter && !fsPath.startsWith(filter)) {
			continue;
		}
		if (workDir && !fsPath.startsWith(workDir)) {
			continue;
		}
		for (const d of diags) {
			out.push(serializeDiagnostic(uri, d));
		}
	}
	respondJSON(res, 200, out);
}

function serializeDiagnostic(uri, d) {
	return {
		uri: uri.toString(),
		filePath: uri.fsPath,
		range: serializeRange(d.range),
		severity: severityName(d.severity),
		message: d.message,
		source: d.source || '',
		code: serializeCode(d.code),
	};
}

function serializeRange(range) {
	if (!range) {
		return null;
	}
	return {
		start: { line: range.start.line, character: range.start.character },
		end: { line: range.end.line, character: range.end.character },
	};
}

function severityName(severity) {
	// vscode.DiagnosticSeverity: Error=0, Warning=1, Information=2, Hint=3
	switch (severity) {
		case 0: return 'error';
		case 1: return 'warning';
		case 2: return 'info';
		case 3: return 'hint';
		default: return 'unknown';
	}
}

function serializeCode(code) {
	if (code == null) {
		return '';
	}
	if (typeof code === 'string' || typeof code === 'number') {
		return String(code);
	}
	if (typeof code === 'object' && code.value != null) {
		return String(code.value);
	}
	return '';
}

// --- workspace handlers ----------------------------------------------------

async function handleWorkspaceFolders(res, vscode) {
	const folders = vscode.workspace.workspaceFolders || [];
	const out = folders.map((folder) => ({
		uri: folder.uri.toString(),
		name: folder.name,
		index: folder.index,
		fsPath: folder.uri.fsPath,
	}));
	respondJSON(res, 200, out);
}

async function handleFindFiles(res, url, vscode) {
	const glob = url.searchParams.get('glob') || '**/*';
	const exclude = url.searchParams.get('excludes') || null;
	const maxResults = parseInt(url.searchParams.get('maxResults') || '0', 10) || undefined;
	try {
		const results = await vscode.workspace.findFiles(glob, exclude, maxResults);
		respondJSON(res, 200, results.map((uri) => ({ uri: uri.toString(), fsPath: uri.fsPath })));
	} catch (err) {
		respondError(res, 500, 'find_files_failed', errorMessage(err));
	}
}

async function handleFindText(res, url, vscode) {
	const query = url.searchParams.get('query') || '';
	if (!query) {
		return respondError(res, 400, 'invalid_request', 'query is required');
	}
	const isRegex = url.searchParams.get('isRegex') === 'true';
	const isCaseSensitive = url.searchParams.get('isCaseSensitive') === 'true';
	const isWordMatch = url.searchParams.get('isWordMatch') === 'true';
	const includeGlob = url.searchParams.get('include') || '**/*';
	const excludeGlob = url.searchParams.get('exclude') || null;

	// Prefer findTextInFiles if available (proposed API). Otherwise fall back
	// to scanning matches with findFiles + manual content read. We can't
	// require `findTextInFiles` because it lives behind a proposed-API flag.
	if (typeof vscode.workspace.findTextInFiles === 'function') {
		const matches = [];
		try {
			await vscode.workspace.findTextInFiles(
				{ pattern: query, isRegExp: isRegex, isCaseSensitive, isWordMatch },
				{ include: includeGlob, exclude: excludeGlob || undefined },
				(match) => {
					matches.push({
						uri: match.uri.toString(),
						fsPath: match.uri.fsPath,
						range: serializeRange(match.ranges ? match.ranges[0] : match.range),
						preview: match.preview && match.preview.text ? match.preview.text : '',
					});
				}
			);
			respondJSON(res, 200, matches);
			return;
		} catch (err) {
			// fall through to findFiles fallback
			console.warn(`[openvsmobile-bridge] findTextInFiles failed, falling back: ${err}`);
		}
	}

	// Fallback: findFiles + manual scan. Heavy, but works without proposed API.
	try {
		const matcher = compileMatcher(query, { isRegex, isCaseSensitive, isWordMatch });
		const uris = await vscode.workspace.findFiles(includeGlob, excludeGlob || null, 1000);
		const matches = [];
		for (const uri of uris) {
			let bytes;
			try {
				bytes = await vscode.workspace.fs.readFile(uri);
			} catch (_err) {
				continue;
			}
			const text = Buffer.from(bytes).toString('utf8');
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				let result;
				while ((result = matcher.exec(line)) !== null) {
					matches.push({
						uri: uri.toString(),
						fsPath: uri.fsPath,
						range: {
							start: { line: i, character: result.index },
							end: { line: i, character: result.index + result[0].length },
						},
						preview: line,
					});
					if (!matcher.global) {
						break;
					}
				}
			}
		}
		respondJSON(res, 200, matches);
	} catch (err) {
		respondError(res, 500, 'find_text_failed', errorMessage(err));
	}
}

function compileMatcher(query, opts) {
	const flags = `g${opts.isCaseSensitive ? '' : 'i'}`;
	let source = opts.isRegex ? query : escapeRegex(query);
	if (opts.isWordMatch) {
		source = `\\b${source}\\b`;
	}
	return new RegExp(source, flags);
}

function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- events / SSE ----------------------------------------------------------

const SSE_KEEPALIVE_MS = 15000;
const DIAGNOSTICS_DEBOUNCE_MS = 200;

function createEventBroker() {
	const subscribers = new Set();
	let closed = false;
	return {
		emit(name, payload) {
			if (closed) {
				return;
			}
			for (const sub of subscribers) {
				try {
					sub.write(name, payload);
				} catch (_err) {
					// dead subscribers are pruned by their own close handler.
				}
			}
		},
		add(sub) {
			if (closed) {
				return () => {};
			}
			subscribers.add(sub);
			return () => subscribers.delete(sub);
		},
		shutdown() {
			closed = true;
			for (const sub of subscribers) {
				try {
					sub.close();
				} catch (_err) {
					// best-effort
				}
			}
			subscribers.clear();
		},
	};
}

function handleEvents(req, res, broker, startedAt) {
	if (!broker) {
		return respondError(res, 503, 'events_unavailable', 'event broker not initialised');
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
		// Disable proxy buffering when present (e.g. nginx). Harmless otherwise.
		'X-Accel-Buffering': 'no',
	});
	// Flush headers immediately so the client knows the stream is alive.
	if (typeof res.flushHeaders === 'function') {
		res.flushHeaders();
	}

	let closed = false;
	const writeRaw = (chunk) => {
		if (closed) {
			return;
		}
		try {
			res.write(chunk);
		} catch (_err) {
			closed = true;
		}
	};

	const writeEvent = (name, payload) => {
		const data = JSON.stringify(payload === undefined ? null : payload);
		writeRaw(`event: ${name}\ndata: ${data}\n\n`);
	};

	// Initial ready frame so the consumer can confirm the stream is alive.
	writeEvent('ready', { pid: process.pid, startedAt });

	const subscription = {
		write(name, payload) {
			writeEvent(name, payload);
		},
		close() {
			if (!closed) {
				closed = true;
				try {
					res.end();
				} catch (_err) {
					// ignore
				}
			}
		},
	};
	const removeSubscriber = broker.add(subscription);

	// Keepalive comment so intermediate proxies (and idle TCP timers) don't
	// drop the connection.
	const keepalive = setInterval(() => {
		writeRaw(': keepalive\n\n');
	}, SSE_KEEPALIVE_MS);
	if (typeof keepalive.unref === 'function') {
		keepalive.unref();
	}

	const cleanup = () => {
		if (closed) {
			return;
		}
		closed = true;
		clearInterval(keepalive);
		removeSubscriber();
		try {
			res.end();
		} catch (_err) {
			// ignore
		}
	};

	req.on('close', cleanup);
	req.on('error', cleanup);
	res.on('error', cleanup);
}

// subscribeVSCodeEvents wires the extension host event sources we care about
// (git repo state, language diagnostics) into the broker. Returns an array of
// disposables that unsubscribe on deactivate.
function subscribeVSCodeEvents(vscode, broker) {
	const disposables = [];

	// --- diagnostics --- a single onDidChange subscription, debounced.
	let diagPending = new Set();
	let diagTimer = null;
	const flushDiagnostics = () => {
		const uris = Array.from(diagPending);
		diagPending = new Set();
		diagTimer = null;
		if (uris.length === 0) {
			return;
		}
		broker.emit('diagnostics.changed', { uris });
	};
	if (vscode.languages && typeof vscode.languages.onDidChangeDiagnostics === 'function') {
		disposables.push(
			vscode.languages.onDidChangeDiagnostics((e) => {
				if (!e || !Array.isArray(e.uris)) {
					return;
				}
				for (const u of e.uris) {
					try {
						diagPending.add(u.toString());
					} catch (_err) {
						// ignore individual uri stringification errors
					}
				}
				if (diagTimer === null) {
					diagTimer = setTimeout(flushDiagnostics, DIAGNOSTICS_DEBOUNCE_MS);
					if (typeof diagTimer.unref === 'function') {
						diagTimer.unref();
					}
				}
			})
		);
	}
	// Also tear down the pending timer when we deactivate.
	disposables.push({
		dispose() {
			if (diagTimer !== null) {
				clearTimeout(diagTimer);
				diagTimer = null;
			}
			diagPending = new Set();
		},
	});

	// --- git --- the built-in git extension exposes onDidChange per repo.
	const repoSubs = new Map(); // rootPath -> dispose()
	const attachRepo = (repo) => {
		if (!repo || !repo.state || typeof repo.state.onDidChange !== 'function') {
			return;
		}
		let rootPath = '';
		try {
			rootPath = repo.rootUri && repo.rootUri.fsPath ? repo.rootUri.fsPath : '';
		} catch (_err) {
			rootPath = '';
		}
		if (!rootPath || repoSubs.has(rootPath)) {
			return;
		}
		const sub = repo.state.onDidChange(() => {
			broker.emit('git.repositoryChanged', { rootPath });
		});
		repoSubs.set(rootPath, sub);
	};
	const detachRepo = (repo) => {
		let rootPath = '';
		try {
			rootPath = repo && repo.rootUri && repo.rootUri.fsPath ? repo.rootUri.fsPath : '';
		} catch (_err) {
			rootPath = '';
		}
		if (!rootPath) {
			return;
		}
		const sub = repoSubs.get(rootPath);
		if (sub) {
			try {
				sub.dispose();
			} catch (_err) {
				// best-effort
			}
			repoSubs.delete(rootPath);
		}
	};

	const gitExt = vscode.extensions && typeof vscode.extensions.getExtension === 'function'
		? vscode.extensions.getExtension('vscode.git')
		: null;
	if (gitExt) {
		const wireGitAPI = (api) => {
			if (!api) {
				return;
			}
			try {
				const repos = Array.isArray(api.repositories) ? api.repositories : [];
				for (const repo of repos) {
					attachRepo(repo);
				}
			} catch (err) {
				console.warn(`[openvsmobile-bridge] failed to attach existing git repos: ${err}`);
			}
			if (typeof api.onDidOpenRepository === 'function') {
				disposables.push(api.onDidOpenRepository((repo) => attachRepo(repo)));
			}
			if (typeof api.onDidCloseRepository === 'function') {
				disposables.push(api.onDidCloseRepository((repo) => detachRepo(repo)));
			}
		};

		const activatePromise = gitExt.isActive
			? Promise.resolve(gitExt.exports)
			: gitExt.activate();
		Promise.resolve(activatePromise)
			.then((exports) => {
				if (!exports || typeof exports.getAPI !== 'function') {
					return;
				}
				try {
					wireGitAPI(exports.getAPI(1));
				} catch (err) {
					console.warn(`[openvsmobile-bridge] git getAPI(1) failed: ${err}`);
				}
			})
			.catch((err) => {
				console.warn(`[openvsmobile-bridge] failed to activate git extension: ${err}`);
			});
	}

	disposables.push({
		dispose() {
			for (const sub of repoSubs.values()) {
				try {
					sub.dispose();
				} catch (_err) {
					// best-effort
				}
			}
			repoSubs.clear();
		},
	});

	return disposables;
}

// --- low-level helpers -----------------------------------------------------

function requireQuery(res, url, name) {
	const value = url.searchParams.get(name);
	if (!value) {
		respondError(res, 400, 'invalid_request', `${name} query parameter is required`);
		return null;
	}
	return value;
}

async function readJSONBody(req, res) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
		if (chunks.reduce((sum, c) => sum + c.length, 0) > 1024 * 1024) {
			respondError(res, 413, 'body_too_large', 'request body exceeds 1MiB');
			return null;
		}
	}
	if (chunks.length === 0) {
		return {};
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	try {
		return JSON.parse(raw);
	} catch (err) {
		respondError(res, 400, 'invalid_request', `invalid JSON body: ${errorMessage(err)}`);
		return null;
	}
}

function respondJSON(res, status, payload) {
	const body = JSON.stringify(payload === undefined ? null : payload);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
	});
	res.end(body);
}

function respondError(res, status, code, message) {
	respondJSON(res, status, { error: code, detail: message });
}

function errorMessage(err) {
	if (!err) {
		return '';
	}
	if (typeof err === 'string') {
		return err;
	}
	return err.message || String(err);
}

module.exports = { activate, deactivate };
