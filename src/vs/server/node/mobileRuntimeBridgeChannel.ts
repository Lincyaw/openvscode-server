/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { promises as fs, mkdirSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { CancellationToken } from '../../base/common/cancellation.js';
import { Event, Emitter } from '../../base/common/event.js';
import { IMarkdownString } from '../../base/common/htmlContent.js';
import { URI } from '../../base/common/uri.js';
import { getCodeActions } from '../../editor/contrib/codeAction/browser/codeAction.js';
import { CodeActionTriggerSource } from '../../editor/contrib/codeAction/common/types.js';
import { getDocumentFormattingEditsUntilResult } from '../../editor/contrib/format/browser/format.js';
import { getDefinitionsAtPosition, getReferencesAtPosition } from '../../editor/contrib/gotoSymbol/browser/goToSymbol.js';
import { getHoversPromise } from '../../editor/contrib/hover/browser/getHover.js';
import { provideSignatureHelp } from '../../editor/contrib/parameterHints/browser/provideSignatureHelp.js';
import { rename as provideRenameEdits } from '../../editor/contrib/rename/browser/rename.js';
import { provideSuggestionItems } from '../../editor/contrib/suggest/browser/suggest.js';
import { Position } from '../../editor/common/core/position.js';
import { Range } from '../../editor/common/core/range.js';
import * as languages from '../../editor/common/languages.js';
import { ITextModel } from '../../editor/common/model.js';
import { createTextBufferFactory } from '../../editor/common/model/textModel.js';
import { IEditorWorkerService } from '../../editor/common/services/editorWorker.js';
import { ILanguageFeaturesService } from '../../editor/common/services/languageFeatures.js';
import { IServerChannel } from '../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../platform/markers/common/markers.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { Progress } from '../../platform/progress/common/progress.js';
import { RemoteAgentConnectionContext } from '../../platform/remote/common/remoteAgentEnvironment.js';
import { IProcessDataEvent, IPtyHostService, ITerminalLaunchError, ITerminalProcessOptions, ProcessPropertyType, TitleEventSource } from '../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, WorkbenchState } from '../../platform/workspace/common/workspace.js';
import { getWorkspaceSymbols, IWorkspaceSymbol } from '../../workbench/contrib/search/common/search.js';
import { DEFAULT_MAX_SEARCH_RESULTS, ISearchComplete, ISearchService, isFileMatch, QueryType, resultIsMatch } from '../../workbench/services/search/common/search.js';
import { IResolvedTextFileEditorModel, ITextFileEditorModel, ITextFileService } from '../../workbench/services/textfile/common/textfiles.js';
import { createTerminalEnvironment } from '../../workbench/contrib/terminal/common/terminalEnvironment.js';

// ---------------------------------------------------------------------------
// Bridge metadata writer
// ---------------------------------------------------------------------------

export class MobileBridgeMetadataWriter {
	private readonly metadataPath: string;
	private generation: string;

	constructor() {
		const envOverride = process.env.OPENVSCODE_MOBILE_BRIDGE_METADATA_PATH;
		if (envOverride) {
			this.metadataPath = envOverride;
		} else {
			this.metadataPath = join(homedir(), '.config', 'openvscode-mobile', 'bridge-metadata.json');
		}
		this.generation = this.createGeneration();
	}

	private createGeneration(): string {
		return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	}

	write(): void {
		try {
			mkdirSync(join(homedir(), '.config', 'openvscode-mobile'), { recursive: true });
		} catch (_) {
			// directory may already exist
		}

		const metadata = {
			protocolVersion: '2026-04-20',
			generation: this.generation,
			state: 'ready',
			capabilities: {
				documents: {
					enabled: true,
				},
				lsp: {
					enabled: true,
					diagnostics: { enabled: true, eventStream: true },
					completion: { enabled: true, textEdit: true, additionalTextEdits: true },
					hover: { enabled: true, markdown: true },
					definition: { enabled: true },
					references: { enabled: true },
					signatureHelp: { enabled: true },
					formatting: { enabled: true },
					codeActions: { enabled: true, command: true, workspaceEdit: true },
					rename: { enabled: true, workspaceEdit: true },
					documentSymbols: { enabled: true },
				},
				git: {
					enabled: true,
					push: true,
					pull: true,
					fetch: true,
					conflicts: true,
					aheadBehind: true,
				},
				terminal: {
					enabled: true,
					persistentSessions: false,
					split: true,
					commandDetection: false,
				},
				workspace: {
					enabled: true,
					search: true,
					symbols: true,
					folders: true,
					problems: true,
					eventStream: true,
				},
			},
			bridgeVersion: '0.1.0',
			updatedAt: new Date().toISOString(),
		};

		try {
			fs.writeFile(this.metadataPath, JSON.stringify(metadata, null, 2));
		} catch (err) {
			console.error('[MobileBridge] failed to write metadata:', err);
		}
	}
}

// ---------------------------------------------------------------------------
// Git channel
// ---------------------------------------------------------------------------

interface GitRepositoryDocument {
	path: string;
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	remotes: GitRemote[];
	staged: GitChange[];
	unstaged: GitChange[];
	untracked: GitChange[];
	conflicts: GitChange[];
	mergeChanges: GitChange[];
}

interface GitRemote {
	name: string;
	fetchUrl?: string;
	pushUrl?: string;
	isReadOnly?: boolean;
	branches?: string[];
}

interface GitChange {
	path: string;
	originalPath?: string;
	status?: string;
	indexStatus?: string;
	workingTreeStatus?: string;
	mergeStatus?: GitMergeStatus;
}

interface GitDiffDocument {
	path: string;
	diff: string;
	staged: boolean;
}

interface GitMergeStatus {
	kind?: string;
	current?: string;
	incoming?: string;
}

interface GitRuntimeBridgeInfo {
	port: number;
	token: string;
}

const gitRuntimeInfoPath = process.env.OPENVSCODE_MOBILE_GIT_RUNTIME_INFO_PATH
	|| join(homedir(), '.config', 'openvscode-mobile', 'git-runtime.json');

function wait(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

class GitRuntimeBridgeClient {
	constructor() { }

	private async readInfo(retries = 20): Promise<GitRuntimeBridgeInfo> {
		let lastError: Error | undefined;
		for (let attempt = 0; attempt < retries; attempt++) {
			try {
				const raw = await fs.readFile(gitRuntimeInfoPath, 'utf8');
				const parsed = JSON.parse(raw) as Partial<GitRuntimeBridgeInfo>;
				if (typeof parsed.port === 'number' && typeof parsed.token === 'string' && parsed.token.length > 0) {
					return { port: parsed.port, token: parsed.token };
				}
				lastError = new Error('Git runtime bridge metadata is malformed.');
			} catch (error) {
				lastError = asError(error);
			}
			await wait(250);
		}
		throw lastError ?? new Error('Git runtime bridge metadata is unavailable.');
	}

	private async requestJson<T>(pathname: string, payload?: Record<string, unknown>): Promise<T> {
		const info = await this.readInfo();
		return new Promise<T>((resolve, reject) => {
			const body = payload ? JSON.stringify(payload) : undefined;
			const request = http.request({
				host: '127.0.0.1',
				port: info.port,
				path: pathname,
				method: body ? 'POST' : 'GET',
				headers: {
					'authorization': `Bearer ${info.token}`,
					'content-type': 'application/json',
					...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
				},
			}, response => {
				let responseBody = '';
				response.setEncoding('utf8');
				response.on('data', chunk => responseBody += chunk);
				response.on('end', () => {
					if ((response.statusCode ?? 500) >= 400) {
						reject(new Error(responseBody || `Git runtime bridge request failed with status ${response.statusCode ?? 500}`));
						return;
					}
					try {
						resolve(JSON.parse(responseBody) as T);
					} catch (error) {
						reject(asError(error));
					}
				});
			});
			request.on('error', reject);
			if (body) {
				request.write(body);
			}
			request.end();
		});
	}

	repository(path: string): Promise<GitRepositoryDocument> {
		return this.requestJson<GitRepositoryDocument>('/repository', { path });
	}

	command<T>(command: string, payload: Record<string, unknown>): Promise<T> {
		return this.requestJson<T>(`/${command}`, payload);
	}

	watchRepository(path: string, onEvent: (repository: GitRepositoryDocument) => void, onError: (error: Error) => void): () => void {
		let disposed = false;
		let request: http.ClientRequest | undefined;
		let reconnectHandle: ReturnType<typeof setTimeout> | undefined;

		const scheduleReconnect = () => {
			if (disposed || reconnectHandle) {
				return;
			}
			reconnectHandle = setTimeout(() => {
				reconnectHandle = undefined;
				void connect();
			}, 1000);
		};

		const connect = async () => {
			try {
				const info = await this.readInfo(40);
				if (disposed) {
					return;
				}
				request = http.request({
					host: '127.0.0.1',
					port: info.port,
					path: `/events?path=${encodeURIComponent(path)}`,
					method: 'GET',
					headers: {
						'authorization': `Bearer ${info.token}`,
						'accept': 'application/x-ndjson',
					},
				}, response => {
					if ((response.statusCode ?? 500) >= 400) {
						onError(new Error(`Git runtime event stream failed with status ${response.statusCode ?? 500}`));
						scheduleReconnect();
						return;
					}
					let buffer = '';
					response.setEncoding('utf8');
					response.on('data', chunk => {
						buffer += chunk;
						while (true) {
							const newlineIndex = buffer.indexOf('\n');
							if (newlineIndex < 0) {
								break;
							}
							const line = buffer.slice(0, newlineIndex).trim();
							buffer = buffer.slice(newlineIndex + 1);
							if (!line) {
								continue;
							}
							try {
								onEvent(JSON.parse(line) as GitRepositoryDocument);
							} catch (error) {
								onError(asError(error));
							}
						}
					});
					response.on('end', scheduleReconnect);
				});
				request.on('error', error => {
					onError(asError(error));
					scheduleReconnect();
				});
				request.end();
			} catch (error) {
				onError(asError(error));
				scheduleReconnect();
			}
		};

		void connect();
		return () => {
			disposed = true;
			if (reconnectHandle) {
				clearTimeout(reconnectHandle);
			}
			request?.destroy();
		};
	}
}

export class MobileGitChannel implements IServerChannel<RemoteAgentConnectionContext> {
	private readonly runtimeClient: GitRuntimeBridgeClient;

	constructor(private readonly _logService: ILogService) {
		this.runtimeClient = new GitRuntimeBridgeClient();
	}

	call(_ctx: RemoteAgentConnectionContext, command: string, arg?: any): Promise<any> {
		this._logService.trace(`[MobileGitChannel] ${command}`, arg);
		switch (command) {
			case 'repository': return this.getRepository(arg);
			case 'stage': return this.stage(arg);
			case 'unstage': return this.unstage(arg);
			case 'commit': return this.commit(arg);
			case 'checkout': return this.checkout(arg);
			case 'fetch': return this.fetch(arg);
			case 'pull': return this.pull(arg);
			case 'push': return this.push(arg);
			case 'discard': return this.discard(arg);
			case 'diff': return this.diff(arg);
			case 'stash': return this.stash(arg);
			case 'stash/apply': return this.stashApply(arg);
		}
		throw new Error(`Command not found: ${command}`);
	}

	listen(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
		switch (event) {
			case 'repositoryChanged':
				return this.subscribeRepositoryChanged(arg?.path as string);
		}
		throw new Error(`Event not found: ${event}`);
	}

	private async getRepository(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		if (!path) { throw new Error('path is required'); }
		return this.runtimeClient.repository(path);
	}

	private async stage(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const files = (arg?.files as string[]) ?? [];
		if (!path) { throw new Error('path is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('stage', { path, files });
	}

	private async unstage(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const files = (arg?.files as string[]) ?? [];
		if (!path) { throw new Error('path is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('unstage', { path, files });
	}

	private async commit(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const message = arg?.message as string;
		if (!path) { throw new Error('path is required'); }
		if (!message) { throw new Error('message is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('commit', { path, message });
	}

	private async checkout(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const ref = arg?.ref as string;
		const create = arg?.create as boolean;
		if (!path) { throw new Error('path is required'); }
		if (!ref) { throw new Error('ref is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('checkout', { path, ref, create: !!create });
	}

	private async fetch(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const remote = arg?.remote as string;
		if (!path) { throw new Error('path is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('fetch', { path, remote });
	}

	private async pull(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const remote = arg?.remote as string;
		const branch = arg?.branch as string;
		if (!path) { throw new Error('path is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('pull', { path, remote, branch });
	}

	private async push(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const remote = arg?.remote as string;
		const branch = arg?.branch as string;
		const setUpstream = arg?.setUpstream as boolean;
		if (!path) { throw new Error('path is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('push', { path, remote, branch, setUpstream: !!setUpstream });
	}

	private async discard(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const files = (arg?.files as string[]) ?? [];
		if (!path) { throw new Error('path is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('discard', { path, files });
	}

	private async diff(arg: any): Promise<GitDiffDocument> {
		const path = arg?.path as string;
		const file = arg?.file as string;
		const staged = arg?.staged as boolean;
		if (!path) { throw new Error('path is required'); }
		if (!file) { throw new Error('file is required'); }
		return this.runtimeClient.command<GitDiffDocument>('diff', { path, file, staged: !!staged });
	}

	private async stash(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const message = arg?.message as string;
		const includeUntracked = arg?.includeUntracked as boolean;
		if (!path) { throw new Error('path is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('stash', { path, message, includeUntracked: !!includeUntracked });
	}

	private async stashApply(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const stashRef = arg?.stash as string;
		const pop = arg?.pop as boolean;
		if (!path) { throw new Error('path is required'); }
		return this.runtimeClient.command<GitRepositoryDocument>('stash/apply', { path, stash: stashRef, pop: !!pop });
	}

	private subscribeRepositoryChanged(path: string | undefined): Event<any> {
		if (!path) { return Event.None; }
		return (listener, thisArgs, disposables) => {
			const stop = this.runtimeClient.watchRepository(
				path,
				repository => listener.call(thisArgs, repository),
				error => this._logService.warn('[MobileGitChannel] repositoryChanged stream error', error),
			);
			const disposable = {
				dispose: () => stop(),
			};
			if (Array.isArray(disposables)) {
				disposables.push(disposable);
			} else {
				disposables?.add(disposable);
			}
			return disposable;
		};
	}
}

// ---------------------------------------------------------------------------
// Terminal channel
// ---------------------------------------------------------------------------

interface TerminalSessionDocument {
	id: string;
	name: string;
	cwd: string;
	profile: string;
	state: 'running' | 'exited';
	exitCode?: number;
	rows: number;
	cols: number;
	shellIntegration?: Record<string, unknown>;
}

interface TerminalAttachDocument {
	session: TerminalSessionDocument;
	backlog?: string;
}

interface TerminalLifecycleEnvelope {
	type: 'created' | 'updated' | 'closed';
	session: TerminalSessionDocument;
}

interface TerminalStreamEnvelope {
	type: 'output' | 'exit' | 'closed';
	data?: string;
	session?: TerminalSessionDocument;
}

interface TerminalSessionRecord {
	processId: number;
	document: TerminalSessionDocument;
	backlog: Buffer;
	stream: Emitter<TerminalStreamEnvelope>;
}

const maxTerminalBacklogBytes = 64 * 1024;

export class MobileTerminalChannel implements IServerChannel<RemoteAgentConnectionContext> {
	private readonly sessionChanged = new Emitter<TerminalLifecycleEnvelope>();
	private readonly sessions = new Map<string, TerminalSessionRecord>();
	private readonly sessionIdsByProcessId = new Map<number, string>();

	constructor(
		private readonly _logService: ILogService,
		private readonly _ptyHostService: IPtyHostService,
		private readonly _configurationService: IConfigurationService,
		private readonly _productService: IProductService,
	) {
		this._ptyHostService.onProcessData(event => this.onProcessData(event.id, event.event));
		this._ptyHostService.onProcessExit(event => this.onProcessExit(event.id, event.event));
		this._ptyHostService.onDidChangeProperty(event => this.onDidChangeProperty(event.id, event.property.type, event.property.value));
	}

	call(_ctx: RemoteAgentConnectionContext, command: string, arg?: any): Promise<any> {
		this._logService.trace(`[MobileTerminalChannel] ${command}`, arg);
		switch (command) {
			case 'list': return Promise.resolve(this.list());
			case 'create': return this.create(arg);
			case 'attach': return Promise.resolve(this.attach(arg));
			case 'input': return this.input(arg);
			case 'resize': return this.resize(arg);
			case 'rename': return this.rename(arg);
			case 'split': return this.split(arg);
			case 'close': return this.close(arg);
		}
		throw new Error(`Command not found: ${command}`);
	}

	listen(_ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
		switch (event) {
			case 'sessionChanged':
				return this.sessionChanged.event;
			case 'stream':
				return this.subscribeStream(arg?.id as string | undefined);
		}
		throw new Error(`Event not found: ${event}`);
	}

	private list(): TerminalSessionDocument[] {
		return Array.from(this.sessions.values(), session => this.serialize(session.document));
	}

	private async create(arg: any): Promise<TerminalSessionDocument> {
		const cwd = typeof arg?.cwd === 'string' && arg.cwd ? arg.cwd : process.env.HOME || '/';
		const profile = normalizeTerminalProfile(arg?.profile as string | undefined);
		const rows = normalizeTerminalDimension(arg?.rows, 24);
		const cols = normalizeTerminalDimension(arg?.cols, 80);
		const name = typeof arg?.name === 'string' && arg.name.trim().length > 0
			? arg.name.trim()
			: basename(profileToShellPath(profile));

		const baseEnv = sanitizeProcessEnv(process.env);
		const shellLaunchConfig = {
			name,
			executable: profileToShellPath(profile),
			cwd,
			type: 'Local' as const,
			isFeatureTerminal: true,
		};
		const env = await createTerminalEnvironment(
			shellLaunchConfig,
			this.getTerminalEnvFromConfig(),
			undefined,
			this._productService.version,
			this.getDetectLocale(),
			baseEnv,
		);
		const options: ITerminalProcessOptions = {
			shellIntegration: {
				enabled: false,
				suggestEnabled: false,
				nonce: '',
			},
			windowsUseConptyDll: false,
			environmentVariableCollections: undefined,
			workspaceFolder: undefined,
			isScreenReaderOptimized: false,
		};
		const processId = await this._ptyHostService.createProcess(
			shellLaunchConfig,
			cwd,
			cols,
			rows,
			'11',
			env,
			baseEnv,
			options,
			false,
			'openvsmobile',
			'OpenVS Mobile',
		);

		const document: TerminalSessionDocument = {
			id: formatTerminalSessionId(processId),
			name,
			cwd,
			profile,
			state: 'running',
			rows,
			cols,
		};
		const session: TerminalSessionRecord = {
			processId,
			document,
			backlog: Buffer.alloc(0),
			stream: new Emitter<TerminalStreamEnvelope>(),
		};
		this.sessions.set(document.id, session);
		this.sessionIdsByProcessId.set(processId, document.id);

		const startResult = await this._ptyHostService.start(processId);
		if (isTerminalLaunchError(startResult)) {
			this.sessions.delete(document.id);
			this.sessionIdsByProcessId.delete(processId);
			session.stream.dispose();
			throw new Error(startResult.message);
		}

		this.sessionChanged.fire({ type: 'created', session: this.serialize(document) });
		return this.serialize(document);
	}

	private attach(arg: any): TerminalAttachDocument {
		const session = this.getSession(arg?.id as string | undefined);
		return {
			session: this.serialize(session.document),
			...(session.backlog.length > 0 ? { backlog: session.backlog.toString('base64') } : {}),
		};
	}

	private async input(arg: any): Promise<TerminalSessionDocument> {
		const session = this.getSession(arg?.id as string | undefined);
		if (session.document.state !== 'running') {
			throw new Error(`terminal ${session.document.id} is not running`);
		}
		const data = typeof arg?.data === 'string' ? arg.data : '';
		if (!data) {
			throw new Error('data is required');
		}
		await this._ptyHostService.input(session.processId, data);
		return this.serialize(session.document);
	}

	private async resize(arg: any): Promise<TerminalSessionDocument> {
		const session = this.getSession(arg?.id as string | undefined);
		if (session.document.state !== 'running') {
			throw new Error(`terminal ${session.document.id} is not running`);
		}
		const rows = normalizeTerminalDimension(arg?.rows, session.document.rows);
		const cols = normalizeTerminalDimension(arg?.cols, session.document.cols);
		await this._ptyHostService.resize(session.processId, cols, rows);
		session.document.rows = rows;
		session.document.cols = cols;
		this.sessionChanged.fire({ type: 'updated', session: this.serialize(session.document) });
		return this.serialize(session.document);
	}

	private async rename(arg: any): Promise<TerminalSessionDocument> {
		const session = this.getSession(arg?.id as string | undefined);
		const name = typeof arg?.name === 'string' ? arg.name.trim() : '';
		if (!name) {
			throw new Error('name is required');
		}
		session.document.name = name;
		if (session.document.state === 'running') {
			await this._ptyHostService.updateTitle(session.processId, name, TitleEventSource.Api);
		}
		this.sessionChanged.fire({ type: 'updated', session: this.serialize(session.document) });
		return this.serialize(session.document);
	}

	private async split(arg: any): Promise<TerminalSessionDocument> {
		const parent = this.getSession(arg?.parentId as string | undefined);
		return this.create({
			name: typeof arg?.name === 'string' && arg.name.trim().length > 0 ? arg.name.trim() : `${parent.document.name} split`,
			cwd: parent.document.cwd,
			profile: parent.document.profile,
			rows: parent.document.rows,
			cols: parent.document.cols,
		});
	}

	private async close(arg: any): Promise<TerminalSessionDocument> {
		const session = this.getSession(arg?.id as string | undefined);
		this.sessions.delete(session.document.id);
		this.sessionIdsByProcessId.delete(session.processId);
		if (session.document.state === 'running') {
			session.document.state = 'exited';
			try {
				await this._ptyHostService.shutdown(session.processId, false);
			} catch (error) {
				this._logService.warn('[MobileTerminalChannel] shutdown failed', error);
			}
		}
		const snapshot = this.serialize(session.document);
		session.stream.fire({ type: 'closed', session: snapshot });
		this.sessionChanged.fire({ type: 'closed', session: snapshot });
		session.stream.dispose();
		return snapshot;
	}

	private subscribeStream(id: string | undefined): Event<TerminalStreamEnvelope> {
		if (!id) {
			return Event.None;
		}
		const session = this.sessions.get(id);
		if (!session) {
			return Event.None;
		}
		return (listener, thisArgs, disposables) => {
			const disposable = session.stream.event(listener, thisArgs, disposables);
			if (session.document.state === 'exited') {
				queueMicrotask(() => listener.call(thisArgs, { type: 'exit', session: this.serialize(session.document) }));
			}
			return disposable;
		};
	}

	private onProcessData(processId: number, event: IProcessDataEvent | string): void {
		const session = this.getSessionByProcessId(processId);
		if (!session) {
			return;
		}
		const data = typeof event === 'string' ? event : event.data;
		if (!data) {
			return;
		}
		appendTerminalBacklog(session, data);
		session.stream.fire({
			type: 'output',
			data: Buffer.from(data, 'utf8').toString('base64'),
		});
	}

	private onProcessExit(processId: number, event: number | undefined): void {
		const session = this.getSessionByProcessId(processId);
		if (!session || session.document.state === 'exited') {
			return;
		}
		session.document.state = 'exited';
		session.document.exitCode = typeof event === 'number' ? event : undefined;
		const snapshot = this.serialize(session.document);
		session.stream.fire({ type: 'exit', session: snapshot });
		this.sessionChanged.fire({ type: 'updated', session: snapshot });
	}

	private onDidChangeProperty(processId: number, type: ProcessPropertyType, value: unknown): void {
		const session = this.getSessionByProcessId(processId);
		if (!session) {
			return;
		}
		switch (type) {
			case ProcessPropertyType.Cwd: {
				if (typeof value === 'string' && value.length > 0 && value !== session.document.cwd) {
					session.document.cwd = value;
					this.sessionChanged.fire({ type: 'updated', session: this.serialize(session.document) });
				}
				break;
			}
			case ProcessPropertyType.UsedShellIntegrationInjection: {
				session.document.shellIntegration = { enabled: value === true };
				this.sessionChanged.fire({ type: 'updated', session: this.serialize(session.document) });
				break;
			}
		}
	}

	private getSession(id: string | undefined): TerminalSessionRecord {
		if (!id) {
			throw new Error('id is required');
		}
		const session = this.sessions.get(id);
		if (!session) {
			throw new Error(`terminal ${id} not found`);
		}
		return session;
	}

	private getSessionByProcessId(processId: number): TerminalSessionRecord | undefined {
		const sessionId = this.sessionIdsByProcessId.get(processId);
		return sessionId ? this.sessions.get(sessionId) : undefined;
	}

	private serialize(document: TerminalSessionDocument): TerminalSessionDocument {
		return {
			...document,
			...(document.exitCode === undefined ? { exitCode: undefined } : {}),
			...(document.shellIntegration ? { shellIntegration: { ...document.shellIntegration } } : {}),
		};
	}

	private getTerminalEnvFromConfig(): Record<string, string | null | undefined> | undefined {
		if (process.platform === 'win32') {
			return this._configurationService.getValue('terminal.integrated.env.windows');
		}
		if (process.platform === 'darwin') {
			return this._configurationService.getValue('terminal.integrated.env.osx');
		}
		return this._configurationService.getValue('terminal.integrated.env.linux');
	}

	private getDetectLocale(): 'auto' | 'off' | 'on' {
		return this._configurationService.getValue<'auto' | 'off' | 'on'>('terminal.integrated.detectLocale') ?? 'auto';
	}
}

function formatTerminalSessionId(processId: number): string {
	return `term-${processId}`;
}

function normalizeTerminalProfile(profile: string | undefined): string {
	return profile && profile.trim().length > 0 ? profile.trim() : 'bash';
}

function normalizeTerminalDimension(value: unknown, fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function profileToShellPath(profile: string): string {
	switch (profile) {
		case 'bash':
		case '/bin/bash':
		case '/usr/bin/bash':
			return '/bin/bash';
		case 'zsh':
		case '/bin/zsh':
		case '/usr/bin/zsh':
			return '/bin/zsh';
		case 'sh':
		case '/bin/sh':
			return '/bin/sh';
		default:
			return profile;
	}
}

function sanitizeProcessEnv(input: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === 'string') {
			env[key] = value;
		}
	}
	return env;
}

function appendTerminalBacklog(session: TerminalSessionRecord, data: string): void {
	const next = Buffer.concat([session.backlog, Buffer.from(data, 'utf8')]);
	session.backlog = next.byteLength > maxTerminalBacklogBytes
		? next.subarray(next.byteLength - maxTerminalBacklogBytes)
		: next;
}

function isTerminalLaunchError(result: ITerminalLaunchError | { injectedArgs: string[] } | undefined): result is ITerminalLaunchError {
	return !!result && typeof (result as ITerminalLaunchError).message === 'string';
}

// ---------------------------------------------------------------------------
// Workspace channel
// ---------------------------------------------------------------------------

interface WorkspaceFolderDocument {
	uri: string;
	path: string;
	name: string;
	index: number;
}

interface WorkspaceSymbolDocument {
	name: string;
	containerName?: string;
	kind: number;
	tags?: number[];
	uri: string;
	path: string;
	range: DocumentRange;
}

interface WorkspaceSearchResultDocument {
	file: string;
	line: number;
	column: number;
	content: string;
	linesBefore: string;
	linesAfter: string;
}

interface WorkspaceFileResultDocument {
	path: string;
	name: string;
	isDir: boolean;
}

interface WorkspaceProblemDocument {
	uri: string;
	path: string;
	range: DocumentRange;
	severity?: number;
	code?: string | { value: string; target: string };
	source?: string;
	message: string;
	tags?: number[];
}

interface WorkspaceChangedEnvelope {
	type: 'foldersChanged';
	workbenchState: 'empty' | 'folder' | 'workspace';
	folders: WorkspaceFolderDocument[];
	added: WorkspaceFolderDocument[];
	removed: WorkspaceFolderDocument[];
	changed: WorkspaceFolderDocument[];
}

export class MobileWorkspaceChannel implements IServerChannel<RemoteAgentConnectionContext> {
	private readonly workspaceChangedEmitter = new Emitter<WorkspaceChangedEnvelope>();

	constructor(
		private readonly _logService: ILogService,
		private readonly _searchService: ISearchService,
		private readonly _workspaceContextService: IWorkspaceContextService,
		private readonly _markerService: IMarkerService,
	) {
		this._workspaceContextService.onDidChangeWorkspaceFolders(event => {
			this.workspaceChangedEmitter.fire(this.serializeWorkspaceChanged(event));
		});
		this._workspaceContextService.onDidChangeWorkbenchState(() => {
			this.workspaceChangedEmitter.fire(this.serializeWorkspaceChanged({
				added: [],
				removed: [],
				changed: [],
			}));
		});
	}

	call(_ctx: RemoteAgentConnectionContext, command: string, arg?: any): Promise<any> {
		this._logService.trace(`[MobileWorkspaceChannel] ${command}`, arg);
		switch (command) {
			case 'folders': return Promise.resolve(this.folders());
			case 'symbols': return this.symbols(arg);
			case 'searchFiles': return this.searchFiles(arg);
			case 'searchText': return this.searchText(arg);
			case 'problems': return Promise.resolve(this.problems(arg));
		}
		throw new Error(`Command not found: ${command}`);
	}

	listen(_ctx: RemoteAgentConnectionContext, event: string, _arg?: any): Event<any> {
		switch (event) {
			case 'workspaceChanged':
				return this.workspaceChangedEmitter.event;
		}
		throw new Error(`Event not found: ${event}`);
	}

	private folders(): WorkspaceFolderDocument[] {
		return this.serializeFolders(this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri));
	}

	private async symbols(arg: any): Promise<WorkspaceSymbolDocument[]> {
		const query = typeof arg?.query === 'string' ? arg.query : '';
		const maxResults = normalizeWorkspaceMaxResults(arg?.max, 200);
		const symbols = await getWorkspaceSymbols(query, CancellationToken.None);
		return symbols
			.slice(0, maxResults)
			.map(item => serializeWorkspaceSymbol(item.symbol));
	}

	private async searchFiles(arg: any): Promise<WorkspaceFileResultDocument[]> {
		const query = typeof arg?.query === 'string' ? arg.query.trim() : '';
		if (!query) {
			return [];
		}
		const results = await this._searchService.fileSearch({
			type: QueryType.File,
			folderQueries: this.folderQueries(arg?.workDir as string | undefined),
			filePattern: query,
			maxResults: normalizeWorkspaceMaxResults(arg?.max, 200),
			sortByScore: true,
		}, CancellationToken.None);
		return results.results.map(match => ({
			path: match.resource.fsPath,
			name: basename(match.resource.fsPath),
			isDir: false,
		}));
	}

	private async searchText(arg: any): Promise<WorkspaceSearchResultDocument[]> {
		const query = typeof arg?.query === 'string' ? arg.query.trim() : '';
		if (!query) {
			return [];
		}

		const maxResults = normalizeWorkspaceMaxResults(arg?.max, DEFAULT_MAX_SEARCH_RESULTS);
		const results: WorkspaceSearchResultDocument[] = [];
		const seen = new Set<string>();
		const pushMatches = (complete: ISearchComplete | IFileMatchLike) => {
			for (const fileMatch of complete.results) {
				for (const entry of fileMatch.results ?? []) {
					if (!resultIsMatch(entry)) {
						continue;
					}
					for (const pairing of entry.rangeLocations) {
						const record = serializeWorkspaceSearchResult(fileMatch.resource.fsPath, entry.previewText, pairing);
						const key = `${record.file}:${record.line}:${record.column}:${record.content}`;
						if (seen.has(key)) {
							continue;
						}
						seen.add(key);
						results.push(record);
						if (results.length >= maxResults) {
							return;
						}
					}
					if (results.length >= maxResults) {
						return;
					}
				}
			}
		};

		const complete = await this._searchService.textSearch({
			type: QueryType.Text,
			folderQueries: this.folderQueries(arg?.workDir as string | undefined),
			contentPattern: { pattern: query },
			maxResults,
			previewOptions: {
				matchLines: 1,
				charsPerLine: 256,
			},
		}, CancellationToken.None, progress => {
			if (!isFileMatch(progress) || results.length >= maxResults) {
				return;
			}
			pushMatches({ results: [progress] });
		});
		if (results.length < maxResults) {
			pushMatches(complete);
		}
		return results.slice(0, maxResults);
	}

	private problems(arg: any): WorkspaceProblemDocument[] {
		const maxResults = normalizeWorkspaceMaxResults(arg?.max, 1000);
		const roots = this.problemRoots(arg?.workDir as string | undefined);
		const markers = this._markerService.read({ take: maxResults * 2 });
		const filtered = markers
			.filter(marker => marker.resource.scheme === 'file' && matchesWorkspaceRoots(marker.resource.fsPath, roots))
			.sort((a, b) => compareWorkspaceProblems(a, b))
			.slice(0, maxResults);
		return filtered.map(marker => serializeWorkspaceProblem(marker));
	}

	private folderQueries(workDir: string | undefined) {
		const trimmed = typeof workDir === 'string' ? workDir.trim() : '';
		if (trimmed) {
			return [{ folder: URI.file(trimmed) }];
		}
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return folders.map(folder => ({ folder: folder.uri }));
		}
		return [{ folder: URI.file(process.cwd()) }];
	}

	private problemRoots(workDir: string | undefined): string[] {
		const trimmed = typeof workDir === 'string' ? workDir.trim() : '';
		if (trimmed) {
			return [trimmed];
		}
		const folders = this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri.fsPath);
		return folders.length > 0 ? folders : [process.cwd()];
	}

	private serializeWorkspaceChanged(event: IWorkspaceFoldersChangeEvent): WorkspaceChangedEnvelope {
		return {
			type: 'foldersChanged',
			workbenchState: workbenchStateLabel(this._workspaceContextService.getWorkbenchState()),
			folders: this.serializeFolders(this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri)),
			added: this.serializeFolders(event.added.map(folder => folder.uri)),
			removed: this.serializeFolders(event.removed.map(folder => folder.uri)),
			changed: this.serializeFolders(event.changed.map(folder => folder.uri)),
		};
	}

	private serializeFolders(uris: readonly URI[]): WorkspaceFolderDocument[] {
		return uris.map((uri, index) => ({
			uri: uri.toString(),
			path: uri.fsPath,
			name: basename(uri.fsPath) || uri.fsPath,
			index,
		}));
	}
}

interface IFileMatchLike {
	results: { resource: URI; results?: any[] }[];
}

function normalizeWorkspaceMaxResults(value: unknown, fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function serializeWorkspaceSymbol(symbol: IWorkspaceSymbol): WorkspaceSymbolDocument {
	return {
		name: symbol.name,
		...(symbol.containerName ? { containerName: symbol.containerName } : {}),
		kind: symbol.kind,
		...(symbol.tags?.length ? { tags: symbol.tags } : {}),
		uri: symbol.location.uri.toString(),
		path: symbol.location.uri.fsPath,
		range: serializeRange(symbol.location.range),
	};
}

function serializeWorkspaceSearchResult(path: string, previewText: string, pairing: { source: { startLineNumber: number; startColumn: number }; preview: { startLineNumber: number; endLineNumber: number } }): WorkspaceSearchResultDocument {
	const lines = previewText.replace(/\r\n/g, '\n').split('\n');
	const previewIndex = Math.min(Math.max(pairing.preview.startLineNumber, 0), Math.max(lines.length - 1, 0));
	const content = (lines[previewIndex] ?? previewText).trimEnd();
	return {
		file: path,
		line: pairing.source.startLineNumber + 1,
		column: pairing.source.startColumn + 1,
		content,
		linesBefore: previewIndex > 0 ? (lines[previewIndex - 1] ?? '').trimEnd() : '',
		linesAfter: previewIndex + 1 < lines.length ? (lines[previewIndex + 1] ?? '').trimEnd() : '',
	};
}

function serializeWorkspaceProblem(marker: IMarker): WorkspaceProblemDocument {
	return {
		uri: marker.resource.toString(),
		path: marker.resource.fsPath,
		range: serializeRange(marker),
		...(marker.severity ? { severity: markerSeverityToDiagnosticSeverity(marker.severity) } : {}),
		...(marker.code ? { code: serializeMarkerCode(marker.code) } : {}),
		...(marker.source ? { source: marker.source } : {}),
		message: marker.message,
		...(marker.tags?.length ? { tags: marker.tags } : {}),
	};
}

function compareWorkspaceProblems(a: IMarker, b: IMarker): number {
	if (a.severity !== b.severity) {
		return (b.severity ?? MarkerSeverity.Info) - (a.severity ?? MarkerSeverity.Info);
	}
	if (a.resource.fsPath !== b.resource.fsPath) {
		return a.resource.fsPath.localeCompare(b.resource.fsPath);
	}
	if (a.startLineNumber !== b.startLineNumber) {
		return a.startLineNumber - b.startLineNumber;
	}
	return a.startColumn - b.startColumn;
}

function matchesWorkspaceRoots(candidate: string, roots: readonly string[]): boolean {
	return roots.some(root => candidate === root || candidate.startsWith(`${root}/`) || candidate.startsWith(`${root}\\`));
}

function workbenchStateLabel(state: WorkbenchState): 'empty' | 'folder' | 'workspace' {
	switch (state) {
		case WorkbenchState.FOLDER:
			return 'folder';
		case WorkbenchState.WORKSPACE:
			return 'workspace';
		default:
			return 'empty';
	}
}

function markerSeverityToDiagnosticSeverity(severity: MarkerSeverity): number {
	switch (severity) {
		case MarkerSeverity.Error:
			return 1;
		case MarkerSeverity.Warning:
			return 2;
		case MarkerSeverity.Info:
			return 3;
		default:
			return 4;
	}
}

// ---------------------------------------------------------------------------
// Editor channel
// ---------------------------------------------------------------------------

interface DocumentPosition {
	line: number;
	character: number;
}

interface DocumentRange {
	start: DocumentPosition;
	end: DocumentPosition;
}

interface DocumentChange {
	range?: DocumentRange;
	text: string;
}

interface EditorRequest {
	path: string;
	version: number;
	content?: string;
	changes?: DocumentChange[];
	position?: { line: number; character: number };
	range?: { start: { line: number; character: number }; end: { line: number; character: number } };
	newName?: string;
	workDir?: string;
	context?: Record<string, any>;
	options?: Record<string, any>;
	query?: string;
}

interface DocumentSnapshot {
	path: string;
	version: number;
	content: string;
}

interface BridgeCommandError {
	code: string;
	message: string;
}

interface DocumentCommandResult {
	path?: string;
	version?: number;
	content?: string;
	closed?: boolean;
	error?: BridgeCommandError;
}

interface DocumentSession {
	path: string;
	resource: URI;
	model: ITextFileEditorModel;
	version: number;
}

export class MobileEditorChannel implements IServerChannel<RemoteAgentConnectionContext> {
	private readonly sessions = new Map<string, DocumentSession>();
	private readonly diagnosticsChangedEmitter = new Emitter<any>();

	constructor(
		private readonly _logService: ILogService,
		private readonly _textFileService: ITextFileService,
		private readonly _languageFeaturesService: ILanguageFeaturesService,
		private readonly _editorWorkerService: IEditorWorkerService,
		private readonly _markerService: IMarkerService,
	) {
		this._markerService.onMarkerChanged(resources => {
			for (const resource of resources) {
				const session = this.sessions.get(resource.fsPath || resource.path);
				if (!session) {
					continue;
				}
				this.diagnosticsChangedEmitter.fire(this.diagnosticsDocumentFor(session));
			}
		});
	}

	async call(_ctx: RemoteAgentConnectionContext, command: string, arg?: any): Promise<any> {
		this._logService.trace(`[MobileEditorChannel] ${command}`, arg);
		const req = (arg ?? {}) as EditorRequest;
		switch (command) {
			case 'doc/open':
				return this.openDocument(req);
			case 'doc/change':
				return this.changeDocument(req);
			case 'doc/save':
				return this.saveDocument(req);
			case 'doc/close':
				return this.closeDocument(req);
			case 'doc/state':
				return this.documentState(req);
			case 'diagnostics':
				return this.readDiagnostics(req);
			case 'completion':
				return this.readCompletion(req);
			case 'hover':
				return this.readHover(req);
			case 'definition':
				return this.readDefinition(req);
			case 'references':
				return this.readReferences(req);
			case 'signatureHelp':
				return this.readSignatureHelp(req);
			case 'formatting':
				return this.readFormatting(req);
			case 'codeActions':
				return this.readCodeActions(req);
			case 'rename':
				return this.readRename(req);
			case 'documentSymbols':
				return this.readDocumentSymbols(req);
		}
		throw new Error(`Command not found: ${command}`);
	}

	listen(_ctx: RemoteAgentConnectionContext, event: string, _arg?: any): Event<any> {
		switch (event) {
			case 'diagnosticsChanged':
				return this.diagnosticsChangedEmitter.event;
		}
		throw new Error(`Event not found: ${event}`);
	}

	private async openDocument(req: EditorRequest): Promise<DocumentCommandResult> {
		if (!isValidDocumentPath(req.path)) {
			return commandError('invalid_request', 'document path is required');
		}
		if (!isValidDocumentVersion(req.version)) {
			return commandError('invalid_request', 'document version must be zero or greater');
		}

		let session = this.sessions.get(req.path);
		if (!session) {
			const resource = URI.file(req.path);
			const model = await this._textFileService.files.resolve(resource, typeof req.content === 'string' ? { contents: createTextBufferFactory(req.content) } : undefined);
			session = { path: req.path, resource, model, version: req.version };
			this.sessions.set(req.path, session);
			return snapshotResponse(this.snapshotForSession(session));
		}

		if (req.version < session.version) {
			return commandError('version_conflict', 'document version is stale');
		}

		const currentContent = this.getModelContent(session.model);
		if (req.version === session.version) {
			if (typeof req.content === 'undefined' || req.content === currentContent) {
				return snapshotResponse(this.snapshotForSession(session));
			}
			return commandError('version_conflict', 'document reopen conflicts with tracked buffer');
		}

		if (typeof req.content !== 'string') {
			return commandError('version_conflict', 'document reopen requires content for a newer version');
		}

		if (req.content !== currentContent) {
			await this.setModelContent(session.model, req.content);
		}
		session.version = req.version;
		return snapshotResponse(this.snapshotForSession(session));
	}

	private async changeDocument(req: EditorRequest): Promise<DocumentCommandResult> {
		if (!isValidDocumentPath(req.path)) {
			return commandError('invalid_request', 'document path is required');
		}
		if (!Array.isArray(req.changes) || req.changes.length === 0) {
			return commandError('invalid_request', 'at least one document change is required');
		}

		const session = this.sessions.get(req.path);
		if (!session) {
			return commandError('document_not_open', 'document is not open');
		}
		if (!isValidDocumentVersion(req.version)) {
			return commandError('invalid_request', 'document version must be zero or greater');
		}
		if (req.version <= session.version) {
			return commandError('version_conflict', 'document version is stale');
		}

		let nextContent: string;
		try {
			nextContent = applyDocumentChanges(this.getModelContent(session.model), req.changes);
		} catch (error) {
			return toDocumentCommandError(error);
		}

		await this.setModelContent(session.model, nextContent);
		session.version = req.version;
		return snapshotResponse(this.snapshotForSession(session));
	}

	private async saveDocument(req: Pick<EditorRequest, 'path'>): Promise<DocumentCommandResult> {
		if (!isValidDocumentPath(req.path)) {
			return commandError('invalid_request', 'document path is required');
		}

		const session = this.sessions.get(req.path);
		if (!session) {
			return commandError('document_not_open', 'document is not open');
		}

		const result = await this._textFileService.save(session.resource);
		if (!result) {
			return commandError('document_save_failed', 'failed to save document');
		}
		return snapshotResponse(this.snapshotForSession(session));
	}

	private async closeDocument(req: Pick<EditorRequest, 'path'>): Promise<DocumentCommandResult> {
		if (!isValidDocumentPath(req.path)) {
			return commandError('invalid_request', 'document path is required');
		}

		const session = this.sessions.get(req.path);
		if (!session) {
			return commandError('document_not_open', 'document is not open');
		}

		if (session.model.isDirty()) {
			await session.model.revert();
		}
		await Promise.resolve(this._textFileService.files.canDispose(session.model));
		this.sessions.delete(req.path);
		session.model.dispose();
		return { path: req.path, closed: true };
	}

	private async documentState(req: Pick<EditorRequest, 'path'>): Promise<DocumentCommandResult> {
		if (!isValidDocumentPath(req.path)) {
			return commandError('invalid_request', 'document path is required');
		}

		const session = this.sessions.get(req.path);
		if (!session) {
			return commandError('document_not_open', 'document is not open');
		}
		return snapshotResponse(this.snapshotForSession(session));
	}

	private async readDiagnostics(req: EditorRequest): Promise<{ path: string; version: number; diagnostics: any[] }> {
		const session = await this.ensureSession(req);
		return this.diagnosticsDocumentFor(session);
	}

	private async readCompletion(req: EditorRequest): Promise<{ isIncomplete: boolean; items: any[] }> {
		const { model } = await this.resolveEditorContext(req, true);
		const suggestions = await provideSuggestionItems(
			this._languageFeaturesService.completionProvider,
			model,
			this.toEditorPosition(req.position),
			undefined,
			this.completionContextFor(req),
			CancellationToken.None,
		);

		try {
			return {
				isIncomplete: suggestions.items.some(item => Boolean(item.container.incomplete)),
				items: suggestions.items.filter(item => !item.isInvalid).map(item => serializeCompletionItem(item.completion)),
			};
		} finally {
			suggestions.disposable.dispose();
		}
	}

	private async readHover(req: EditorRequest): Promise<{ contents: any[]; range?: DocumentRange }> {
		const { model } = await this.resolveEditorContext(req, true);
		const hovers = await getHoversPromise(
			this._languageFeaturesService.hoverProvider,
			model,
			this.toEditorPosition(req.position),
			CancellationToken.None,
		);

		const contents = hovers.flatMap(hover => hover.contents.map(serializeMarkdownString));
		const range = hovers.find(hover => hover.range)?.range;
		return {
			contents,
			...(range ? { range: serializeRange(range) } : {}),
		};
	}

	private async readDefinition(req: EditorRequest): Promise<any[]> {
		const { model } = await this.resolveEditorContext(req, true);
		const locations = await getDefinitionsAtPosition(
			this._languageFeaturesService.definitionProvider,
			model,
			this.toEditorPosition(req.position),
			false,
			CancellationToken.None,
		);
		return locations.map(serializeLocation);
	}

	private async readReferences(req: EditorRequest): Promise<any[]> {
		const { model } = await this.resolveEditorContext(req, true);
		const locations = await getReferencesAtPosition(
			this._languageFeaturesService.referenceProvider,
			model,
			this.toEditorPosition(req.position),
			false,
			false,
			CancellationToken.None,
		);
		return locations.map(serializeLocation);
	}

	private async readSignatureHelp(req: EditorRequest): Promise<any> {
		const { model } = await this.resolveEditorContext(req, true);
		const result = await provideSignatureHelp(
			this._languageFeaturesService.signatureHelpProvider,
			model,
			this.toEditorPosition(req.position),
			this.signatureHelpContextFor(req),
			CancellationToken.None,
		);
		if (!result) {
			return null;
		}
		try {
			return result.value;
		} finally {
			setTimeout(() => result.dispose(), 0);
		}
	}

	private async readDocumentSymbols(req: EditorRequest): Promise<any[]> {
		const { model } = await this.resolveEditorContext(req, false);
		const symbols: languages.DocumentSymbol[] = [];
		for (const provider of this._languageFeaturesService.documentSymbolProvider.ordered(model)) {
			const result = await Promise.resolve(provider.provideDocumentSymbols(model, CancellationToken.None)).catch(error => {
				this._logService.error('[MobileEditorChannel] document symbols provider failed', error);
				return undefined;
			});
			if (Array.isArray(result)) {
				symbols.push(...result);
			}
		}
		return symbols.map(serializeDocumentSymbol);
	}

	private async readFormatting(req: EditorRequest): Promise<any[]> {
		const { model } = await this.resolveEditorContext(req, false);
		const edits = await getDocumentFormattingEditsUntilResult(
			this._editorWorkerService,
			this._languageFeaturesService,
			model,
			this.formattingOptionsFor(model, req),
			CancellationToken.None,
		);
		return (edits ?? []).map(edit => serializeTextEdit(edit));
	}

	private async readCodeActions(req: EditorRequest): Promise<any[]> {
		const { model } = await this.resolveEditorContext(req, false);
		if (!req.range) {
			throw bridgeCommandFailure('invalid_request', 'document range is required');
		}

		const actions = await getCodeActions(
			this._languageFeaturesService.codeActionProvider,
			model,
			this.toEditorRange(req.range),
			{
				type: languages.CodeActionTriggerType.Invoke,
				triggerAction: CodeActionTriggerSource.Default,
			},
			Progress.None,
			CancellationToken.None,
		);

		try {
			const serialized: any[] = [];
			for (const item of actions.validActions) {
				await item.resolve(CancellationToken.None);
				serialized.push(serializeCodeAction(item.action));
			}
			return serialized;
		} finally {
			actions.dispose();
		}
	}

	private async readRename(req: EditorRequest): Promise<any> {
		const { model } = await this.resolveEditorContext(req, true);
		const newName = typeof req.newName === 'string' ? req.newName.trim() : '';
		if (!newName) {
			throw bridgeCommandFailure('invalid_request', 'new name is required');
		}

		const edit = await provideRenameEdits(
			this._languageFeaturesService.renameProvider,
			model,
			this.toEditorPosition(req.position),
			newName,
		);
		if (edit.rejectReason) {
			throw bridgeCommandFailure('invalid_request', edit.rejectReason);
		}
		return serializeWorkspaceEdit(edit);
	}

	private snapshotForSession(session: DocumentSession): DocumentSnapshot {
		return {
			path: session.path,
			version: session.version,
			content: this.getModelContent(session.model),
		};
	}

	private getModelContent(model: ITextFileEditorModel): string {
		if (!model.isResolved()) {
			return '';
		}
		return model.textEditorModel.getValue();
	}

	private async setModelContent(model: ITextFileEditorModel, content: string): Promise<void> {
		const resolvedModel = await this.ensureResolvedModel(model);
		resolvedModel.textEditorModel.setValue(content);
	}

	private async ensureResolvedModel(model: ITextFileEditorModel): Promise<IResolvedTextFileEditorModel> {
		const alreadyResolved = model.isResolved();
		if (!alreadyResolved) {
			await (model as ITextFileEditorModel).resolve();
		}
		if (!model.isResolved()) {
			throw new Error('document model is not resolved');
		}
		return model;
	}

	private async ensureSession(req: EditorRequest): Promise<DocumentSession> {
		const result = await this.openDocument(req);
		if (result.error) {
			throw bridgeCommandFailure(result.error.code, result.error.message);
		}
		const session = this.sessions.get(req.path);
		if (!session) {
			throw bridgeCommandFailure('document_not_open', 'document is not open');
		}
		return session;
	}

	private async resolveEditorContext(req: EditorRequest, requirePosition: boolean): Promise<{ session: DocumentSession; model: ITextModel }> {
		if (requirePosition && !req.position) {
			throw bridgeCommandFailure('invalid_request', 'document position is required');
		}
		const session = await this.ensureSession(req);
		const resolved = await this.ensureResolvedModel(session.model);
		return { session, model: resolved.textEditorModel };
	}

	private diagnosticsDocumentFor(session: DocumentSession): { path: string; version: number; diagnostics: any[] } {
		return {
			path: session.path,
			version: session.version,
			diagnostics: this._markerService.read({ resource: session.resource }).map(serializeMarker),
		};
	}

	private toEditorPosition(position: DocumentPosition | undefined): Position {
		if (!position) {
			throw bridgeCommandFailure('invalid_request', 'document position is required');
		}
		if (position.line < 0 || position.character < 0) {
			throw bridgeCommandFailure('invalid_position', 'document position must be zero or greater');
		}
		return new Position(position.line + 1, position.character + 1);
	}

	private completionContextFor(req: EditorRequest): languages.CompletionContext {
		const triggerCharacter = typeof req.context?.triggerCharacter === 'string' ? req.context.triggerCharacter : undefined;
		return {
			triggerCharacter,
			triggerKind: triggerCharacter ? languages.CompletionTriggerKind.TriggerCharacter : languages.CompletionTriggerKind.Invoke,
		};
	}

	private signatureHelpContextFor(req: EditorRequest): languages.SignatureHelpContext {
		const triggerCharacter = typeof req.context?.triggerCharacter === 'string' ? req.context.triggerCharacter : undefined;
		return {
			triggerCharacter,
			triggerKind: triggerCharacter ? languages.SignatureHelpTriggerKind.TriggerCharacter : languages.SignatureHelpTriggerKind.Invoke,
			isRetrigger: Boolean(req.context?.isRetrigger),
		};
	}

	private formattingOptionsFor(model: ITextModel, req: EditorRequest): languages.FormattingOptions {
		const options = model.getOptions();
		const tabSize = Number(req.options?.tabSize);
		const insertSpaces = req.options?.insertSpaces;
		return {
			tabSize: Number.isInteger(tabSize) && tabSize > 0 ? tabSize : options.tabSize,
			insertSpaces: typeof insertSpaces === 'boolean' ? insertSpaces : options.insertSpaces,
		};
	}

	private toEditorRange(range: DocumentRange): Range {
		const start = this.toEditorPosition(range.start);
		const end = this.toEditorPosition(range.end);
		return new Range(start.lineNumber, start.column, end.lineNumber, end.column);
	}
}

function snapshotResponse(snapshot: DocumentSnapshot): DocumentCommandResult {
	return {
		path: snapshot.path,
		version: snapshot.version,
		content: snapshot.content,
	};
}

function commandError(code: string, message: string): DocumentCommandResult {
	return { error: { code, message } };
}

function toDocumentCommandError(error: unknown): DocumentCommandResult {
	if (error && typeof error === 'object') {
		const candidate = error as { code?: unknown; message?: unknown };
		if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
			return commandError(candidate.code, candidate.message);
		}
	}
	return commandError('document_sync_failed', error instanceof Error ? error.message : 'document sync failed');
}

function isValidDocumentPath(path: string | undefined): path is string {
	return typeof path === 'string' && path.trim().length > 0;
}

function isValidDocumentVersion(version: number | undefined): version is number {
	return typeof version === 'number' && Number.isInteger(version) && version >= 0;
}

function applyDocumentChanges(content: string, changes: DocumentChange[]): string {
	let nextContent = content;
	for (const change of changes) {
		nextContent = applyDocumentChange(nextContent, change);
	}
	return nextContent;
}

function applyDocumentChange(content: string, change: DocumentChange): string {
	if (!change.range) {
		return change.text;
	}

	const { start, end } = resolveDocumentRange(content, change.range);
	return `${content.slice(0, start)}${change.text}${content.slice(end)}`;
}

function resolveDocumentRange(content: string, range: DocumentRange): { start: number; end: number } {
	const start = documentOffset(content, range.start);
	const end = documentOffset(content, range.end);
	if (range.end.line < range.start.line || (range.end.line === range.start.line && range.end.character < range.start.character)) {
		throw bridgeCommandFailure('invalid_position', 'document range end precedes start');
	}
	if (end < start) {
		throw bridgeCommandFailure('invalid_position', 'document range end precedes start');
	}
	return { start, end };
}

function documentOffset(content: string, position: DocumentPosition): number {
	if (position.line < 0 || position.character < 0) {
		throw bridgeCommandFailure('invalid_position', 'document position must be zero or greater');
	}

	let offset = 0;
	let line = 0;
	while (line < position.line) {
		const lineBreak = content.indexOf('\n', offset);
		if (lineBreak < 0) {
			throw bridgeCommandFailure('invalid_position', 'document position line is out of range');
		}
		offset = lineBreak + 1;
		line++;
	}

	const lineEnd = content.indexOf('\n', offset);
	const currentLine = content.slice(offset, lineEnd >= 0 ? lineEnd : content.length);
	if (position.character > currentLine.length) {
		throw bridgeCommandFailure('invalid_position', 'document position character is out of range');
	}

	return offset + position.character;
}

function bridgeCommandFailure(code: string, message: string): Error & { code: string } {
	const error = new Error(message) as Error & { code: string };
	error.code = code;
	return error;
}

function serializeRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): DocumentRange {
	return {
		start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
		end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
	};
}

function serializeLocation(location: languages.LocationLink): { uri: string; range: DocumentRange } {
	return {
		uri: location.uri.toString(),
		range: serializeRange(location.targetSelectionRange ?? location.range),
	};
}

function serializeMarkdownString(markdown: IMarkdownString): Record<string, any> {
	return {
		value: markdown.value,
		...(markdown.isTrusted ? { isTrusted: markdown.isTrusted } : {}),
		...(markdown.supportHtml ? { supportHtml: markdown.supportHtml } : {}),
		...(markdown.supportThemeIcons ? { supportThemeIcons: markdown.supportThemeIcons } : {}),
	};
}

function serializeCompletionItem(item: languages.CompletionItem): Record<string, any> {
	const insertAsSnippet = Boolean(item.insertTextRules && (item.insertTextRules & languages.CompletionItemInsertTextRule.InsertAsSnippet));
	return {
		label: item.label,
		...(item.kind !== undefined ? { kind: item.kind } : {}),
		...(item.detail ? { detail: item.detail } : {}),
		...(item.documentation ? { documentation: typeof item.documentation === 'string' ? item.documentation : serializeMarkdownString(item.documentation) } : {}),
		...(item.sortText ? { sortText: item.sortText } : {}),
		...(item.filterText ? { filterText: item.filterText } : {}),
		...(item.insertText ? { insertText: item.insertText } : {}),
		...(insertAsSnippet ? { insertTextFormat: 2 } : {}),
		textEdit: serializeCompletionTextEdit(item),
		...(item.additionalTextEdits?.length ? { additionalTextEdits: item.additionalTextEdits.map(edit => ({ range: serializeRange(edit.range), newText: edit.text })) } : {}),
		...(item.command ? { command: item.command } : {}),
	};
}

function serializeCompletionTextEdit(item: languages.CompletionItem): Record<string, any> {
	const newText = item.insertText ?? '';
	if (Range.isIRange(item.range)) {
		return {
			range: serializeRange(item.range),
			newText,
		};
	}
	return {
		insert: serializeRange(item.range.insert),
		replace: serializeRange(item.range.replace),
		newText,
	};
}

function serializeTextEdit(edit: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string; insertAsSnippet?: boolean; keepWhitespace?: boolean }): Record<string, any> {
	return {
		range: serializeRange(edit.range),
		newText: edit.text,
		...(edit.insertAsSnippet ? { insertAsSnippet: true } : {}),
		...(edit.keepWhitespace ? { keepWhitespace: true } : {}),
	};
}

function serializeWorkspaceEdit(edit: languages.WorkspaceEdit): Record<string, any> {
	const changes: Record<string, any[]> = {};
	const documentChanges: any[] = [];

	for (const current of edit.edits) {
		if (isWorkspaceTextEdit(current)) {
			const resourceKey = current.resource.fsPath || current.resource.path;
			const serializedEdit = serializeTextEdit(current.textEdit);
			changes[resourceKey] = [...(changes[resourceKey] ?? []), serializedEdit];

			let documentChange = documentChanges.find(candidate =>
				candidate?.textDocument?.uri === current.resource.toString()
			);
			if (!documentChange) {
				documentChange = {
					textDocument: {
						uri: current.resource.toString(),
						...(typeof current.versionId === 'number' ? { version: current.versionId } : {}),
					},
					edits: [],
				};
				documentChanges.push(documentChange);
			}
			documentChange.edits.push(serializedEdit);
			continue;
		}

		if (isWorkspaceFileEdit(current)) {
			documentChanges.push(serializeWorkspaceFileEdit(current));
		}
	}

	return {
		changes,
		...(documentChanges.length ? { documentChanges } : {}),
	};
}

function serializeWorkspaceFileEdit(edit: { oldResource?: URI; newResource?: URI; options?: Record<string, any> }): Record<string, any> {
	if (edit.oldResource && edit.newResource) {
		return {
			kind: 'rename',
			oldUri: edit.oldResource.toString(),
			newUri: edit.newResource.toString(),
			...(edit.options ? { options: edit.options } : {}),
		};
	}
	if (edit.newResource) {
		return {
			kind: 'create',
			uri: edit.newResource.toString(),
			...(edit.options ? { options: edit.options } : {}),
		};
	}
	return {
		kind: 'delete',
		uri: edit.oldResource?.toString(),
		...(edit.options ? { options: edit.options } : {}),
	};
}

function serializeCodeAction(action: languages.CodeAction): Record<string, any> {
	return {
		title: action.title,
		...(action.kind ? { kind: action.kind } : {}),
		...(action.command ? { command: action.command } : {}),
		...(action.edit ? { edit: serializeWorkspaceEdit(action.edit) } : {}),
		...(action.isPreferred ? { isPreferred: true } : {}),
		...(action.disabled ? { disabled: { reason: action.disabled } } : {}),
	};
}

function isWorkspaceTextEdit(edit: languages.WorkspaceEdit['edits'][number]): edit is languages.IWorkspaceTextEdit {
	return 'resource' in edit && 'textEdit' in edit;
}

function isWorkspaceFileEdit(edit: languages.WorkspaceEdit['edits'][number]): edit is languages.IWorkspaceFileEdit {
	return 'oldResource' in edit || 'newResource' in edit;
}

function serializeDocumentSymbol(symbol: languages.DocumentSymbol): Record<string, any> {
	return {
		name: symbol.name,
		...(symbol.detail ? { detail: symbol.detail } : {}),
		kind: symbol.kind,
		...(symbol.tags?.length ? { tags: [...symbol.tags] } : {}),
		range: serializeRange(symbol.range),
		selectionRange: serializeRange(symbol.selectionRange),
		...(symbol.children?.length ? { children: symbol.children.map(serializeDocumentSymbol) } : {}),
	};
}

function serializeMarker(marker: IMarker): Record<string, any> {
	return {
		range: serializeRange(marker),
		severity: markerSeverityToLsp(marker.severity),
		...(marker.code ? { code: serializeMarkerCode(marker.code) } : {}),
		...(marker.source ? { source: marker.source } : {}),
		message: marker.message,
		...(marker.tags?.length ? { tags: [...marker.tags] } : {}),
		...(marker.relatedInformation?.length ? {
			relatedInformation: marker.relatedInformation.map(info => ({
				location: {
					uri: info.resource.toString(),
					range: serializeRange(info),
				},
				message: info.message,
			})),
		} : {}),
	};
}

function serializeMarkerCode(code: string | { value: string; target: URI }): string | { value: string; target: string } {
	if (typeof code === 'string') {
		return code;
	}
	return {
		value: code.value,
		target: code.target.toString(),
	};
}

function markerSeverityToLsp(severity: MarkerSeverity): number {
	switch (severity) {
		case MarkerSeverity.Error:
			return 1;
		case MarkerSeverity.Warning:
			return 2;
		case MarkerSeverity.Info:
			return 3;
		case MarkerSeverity.Hint:
		default:
			return 4;
	}
}
