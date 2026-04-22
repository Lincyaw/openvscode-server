/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, mkdirSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { bufferToReadable, VSBuffer } from '../../base/common/buffer.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { Event, Emitter } from '../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { IServerChannel } from '../../base/parts/ipc/common/ipc.js';
import { ITextModel } from '../../editor/common/model.js';
import { Range } from '../../editor/common/core/range.js';
import { IModelService } from '../../editor/common/services/model.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IMarkerService, MarkerSeverity } from '../../platform/markers/common/markers.js';
import { RemoteAgentConnectionContext } from '../../platform/remote/common/remoteAgentEnvironment.js';
import { IRevertOptions, ISaveOptions } from '../../workbench/common/editor.js';
import { IWorkingCopy, IWorkingCopySaveEvent, WorkingCopyCapabilities } from '../../workbench/services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../workbench/services/workingCopy/common/workingCopyService.js';

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
					diagnostics: { enabled: true, push: true },
					completion: { enabled: true, insertTextFormat: true, textEdit: true, additionalTextEdits: true },
					hover: { enabled: true },
					definition: { enabled: true },
					references: { enabled: true },
					signatureHelp: { enabled: true },
					formatting: { enabled: true },
					codeActions: { enabled: true },
					rename: { enabled: true },
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
					persistentSessions: true,
					split: true,
					rename: true,
					commandDetection: false,
				},
				workspace: {
					enabled: false,
				},
			},
			bridgeVersion: '0.2.0',
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
}

interface GitDiffDocument {
	path: string;
	diff: string;
	staged: boolean;
}

interface RuntimeDocumentPosition {
	line: number;
	character: number;
}

interface RuntimeDocumentRange {
	start: RuntimeDocumentPosition;
	end: RuntimeDocumentPosition;
}

interface RuntimeDocumentChange {
	range?: RuntimeDocumentRange;
	text: string;
}

interface RuntimeDocumentSnapshot {
	path: string;
	version: number;
	content: string;
}

interface RuntimeDocumentCommandResponse {
	ok: boolean;
	snapshot?: RuntimeDocumentSnapshot;
	error?: {
		code: string;
		message: string;
	};
	path?: string;
	closed?: boolean;
}

class RuntimeDocumentError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'RuntimeDocumentError';
	}
}

export class MobileGitChannel implements IServerChannel<RemoteAgentConnectionContext> {
	private readonly _onRepositoryChanged = new Emitter<{ path: string; repository: GitRepositoryDocument }>();
	readonly onRepositoryChanged = this._onRepositoryChanged.event;
	private readonly watchers = new Map<string, NodeJS.Timeout>();
	private readonly lastRepositorySnapshots = new Map<string, string>();

	constructor(
		private readonly _logService: ILogService,
		private readonly commandService: ICommandService
	) { }

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
		return this.getRepositoryState(path);
	}

	private async stage(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const files = (arg?.files as string[]) ?? [];
		if (!path) { throw new Error('path is required'); }
		return this.runRepositoryCommand('git.bridge.stage', path, files);
	}

	private async unstage(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const files = (arg?.files as string[]) ?? [];
		if (!path) { throw new Error('path is required'); }
		return this.runRepositoryCommand('git.bridge.unstage', path, files);
	}

	private async commit(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const message = arg?.message as string;
		if (!path) { throw new Error('path is required'); }
		if (!message) { throw new Error('message is required'); }
		return this.runRepositoryCommand('git.bridge.commit', path, message);
	}

	private async checkout(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const ref = arg?.ref as string;
		const create = arg?.create as boolean;
		if (!path) { throw new Error('path is required'); }
		if (!ref) { throw new Error('ref is required'); }
		return this.runRepositoryCommand('git.bridge.checkout', path, ref, !!create);
	}

	private async fetch(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const remote = arg?.remote as string;
		if (!path) { throw new Error('path is required'); }
		return this.runRepositoryCommand('git.bridge.fetch', path, remote);
	}

	private async pull(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const remote = arg?.remote as string;
		const branch = arg?.branch as string;
		if (!path) { throw new Error('path is required'); }
		return this.runRepositoryCommand('git.bridge.pull', path, remote, branch);
	}

	private async push(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const remote = arg?.remote as string;
		const branch = arg?.branch as string;
		const setUpstream = arg?.setUpstream as boolean;
		if (!path) { throw new Error('path is required'); }
		return this.runRepositoryCommand('git.bridge.push', path, remote, branch, !!setUpstream);
	}

	private async discard(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const files = (arg?.files as string[]) ?? [];
		if (!path) { throw new Error('path is required'); }
		return this.runRepositoryCommand('git.bridge.discard', path, files);
	}

	private async diff(arg: any): Promise<GitDiffDocument> {
		const path = arg?.path as string;
		const file = arg?.file as string;
		const staged = arg?.staged as boolean;
		if (!path) { throw new Error('path is required'); }
		if (!file) { throw new Error('file is required'); }
		const result = await this.commandService.executeCommand('git.bridge.diffRepository', URI.file(path).toString(), file, !!staged);
		const payload = isObject(result) ? result : {};
		return {
			path: typeof payload.path === 'string' ? payload.path : file,
			diff: typeof payload.diff === 'string' ? payload.diff : '',
			staged: payload.staged === true,
		};
	}

	private async stash(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const message = arg?.message as string;
		const includeUntracked = arg?.includeUntracked as boolean;
		if (!path) { throw new Error('path is required'); }
		return this.runRepositoryCommand('git.bridge.stash', path, message, !!includeUntracked);
	}

	private async stashApply(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const stashRef = arg?.stash as string;
		const pop = arg?.pop as boolean;
		if (!path) { throw new Error('path is required'); }
		return this.runRepositoryCommand('git.bridge.stashApply', path, stashRef, !!pop);
	}

	private subscribeRepositoryChanged(path: string | undefined): Event<any> {
		if (!path) { return Event.None; }

		const emitter = new Emitter<GitRepositoryDocument>();
		const interval: ReturnType<typeof setInterval> = setInterval(async () => {
			try {
				const repo = await this.getRepositoryState(path);
				const snapshot = JSON.stringify(repo);
				if (this.lastRepositorySnapshots.get(path) === snapshot) {
					return;
				}
				this.lastRepositorySnapshots.set(path, snapshot);
				emitter.fire(repo);
			} catch (_) {
				// ignore polling errors
			}
		}, 1500);

		this.watchers.set(path, interval as any);
		return emitter.event;
	}

	private async getRepositoryState(path: string): Promise<GitRepositoryDocument> {
		const result = await this.commandService.executeCommand('git.bridge.getRepositoryState', URI.file(path).toString());
		const payload = isObject(result) ? result : {};
		const head = isObject(payload.head) ? payload.head : {};
		return {
			path: typeof payload.path === 'string' ? payload.path : path,
			branch: typeof payload.branch === 'string' ? payload.branch : (typeof head.name === 'string' ? head.name : ''),
			upstream: typeof payload.upstream === 'string'
				? payload.upstream
				: (isObject(head.upstream) && typeof head.upstream.remote === 'string' && typeof head.upstream.name === 'string'
					? `${head.upstream.remote}/${head.upstream.name}`
					: ''),
			ahead: typeof payload.ahead === 'number' ? payload.ahead : (typeof head.ahead === 'number' ? head.ahead : 0),
			behind: typeof payload.behind === 'number' ? payload.behind : (typeof head.behind === 'number' ? head.behind : 0),
			remotes: Array.isArray(payload.remotes) ? payload.remotes as GitRemote[] : [],
			staged: Array.isArray(payload.staged) ? payload.staged as GitChange[] : [],
			unstaged: Array.isArray(payload.unstaged) ? payload.unstaged as GitChange[] : [],
			untracked: Array.isArray(payload.untracked) ? payload.untracked as GitChange[] : [],
			conflicts: Array.isArray(payload.conflicts) ? payload.conflicts as GitChange[] : [],
			mergeChanges: Array.isArray(payload.mergeChanges) ? payload.mergeChanges as GitChange[] : [],
		};
	}

	private async runRepositoryCommand(command: string, ...args: unknown[]): Promise<GitRepositoryDocument> {
		const result = await this.commandService.executeCommand(command, URI.file(args[0] as string).toString(), ...args.slice(1));
		const payload = isObject(result) ? result : {};
		return this.getRepositoryState(typeof payload.path === 'string' ? payload.path : (args[0] as string));
	}
}

// ---------------------------------------------------------------------------
// Documents channel
// ---------------------------------------------------------------------------

const mobileDocumentWorkingCopyTypeId = 'openvsmobile.document';

interface RuntimeDocumentSession {
	path: string;
	resource: URI;
	version: number;
	model: ITextModel;
	workingCopy: MobileDocumentWorkingCopy;
	unregisterWorkingCopy: IDisposable;
}

class MobileDocumentWorkingCopy implements IWorkingCopy {
	readonly typeId = mobileDocumentWorkingCopyTypeId;
	readonly capabilities = WorkingCopyCapabilities.None;
	readonly name: string;

	private readonly _onDidChangeDirty = new Emitter<void>();
	private readonly _onDidChangeContent = new Emitter<void>();
	private readonly _onDidSave = new Emitter<IWorkingCopySaveEvent>();
	readonly onDidChangeDirty = this._onDidChangeDirty.event;
	readonly onDidChangeContent = this._onDidChangeContent.event;
	readonly onDidSave = this._onDidSave.event;
	private readonly disposables = new DisposableStore();
	private persistedContent: string;
	private dirty: boolean;
	private suppressModelEvents = false;

	constructor(
		readonly resource: URI,
		private readonly model: ITextModel,
		persistedContent: string,
		private readonly persist: () => Promise<void>,
		private readonly reload: () => Promise<string>
	) {
		this.name = basename(resource.path) || resource.path;
		this.persistedContent = persistedContent;
		this.dirty = this.model.getValue() !== this.persistedContent;
		this.disposables.add(this.model.onDidChangeContent(() => {
			if (this.suppressModelEvents) {
				return;
			}
			this._onDidChangeContent.fire();
			this.updateDirty(this.model.getValue() !== this.persistedContent);
		}));
	}

	isDirty(): boolean {
		return this.dirty;
	}

	isModified(): boolean {
		return this.dirty;
	}

	async backup(_token: CancellationToken) {
		return { content: bufferToReadable(VSBuffer.fromString(this.model.getValue())) };
	}

	async save(options?: ISaveOptions): Promise<boolean> {
		await this.persist();
		this.persistedContent = this.model.getValue();
		this.updateDirty(false);
		this._onDidSave.fire({ reason: options?.reason, source: options?.source });
		return true;
	}

	async revert(_options?: IRevertOptions): Promise<void> {
		const persistedContent = await this.reload();
		this.replaceModelContents(persistedContent);
		this.persistedContent = persistedContent;
		this.updateDirty(false);
	}

	replaceModelContents(content: string): void {
		this.suppressModelEvents = true;
		try {
			this.model.setValue(content);
		} finally {
			this.suppressModelEvents = false;
		}
		this._onDidChangeContent.fire();
		this.updateDirty(this.model.getValue() !== this.persistedContent);
	}

	dispose(): void {
		this.disposables.dispose();
		this._onDidChangeDirty.dispose();
		this._onDidChangeContent.dispose();
		this._onDidSave.dispose();
	}

	private updateDirty(nextDirty: boolean): void {
		if (this.dirty === nextDirty) {
			return;
		}
		this.dirty = nextDirty;
		this._onDidChangeDirty.fire();
	}
}

export class MobileRuntimeDocumentService {
	private readonly sessions = new Map<string, RuntimeDocumentSession>();

	constructor(
		private readonly modelService: IModelService,
		private readonly workingCopyService: IWorkingCopyService
	) { }

	async openDocument(arg: any): Promise<RuntimeDocumentCommandResponse> {
		const path = this.requirePath(arg?.path);
		const version = this.requireVersion(arg?.version);
		const providedContent = typeof arg?.content === 'string' ? arg.content : undefined;
		const existing = this.sessions.get(path);
		if (existing) {
			return { ok: true, snapshot: this.reconcileOpen(existing, version, providedContent) };
		}

		const resource = URI.file(path);
		let model = this.modelService.getModel(resource);
		if (!model) {
			let initialContent = providedContent;
			if (initialContent === undefined) {
				initialContent = await this.readFileForOpen(path);
			}
			model = this.modelService.createModel(initialContent, null, resource);
		} else if (providedContent !== undefined && model.getValue() !== providedContent) {
			model.setValue(providedContent);
		}

		const workingCopy = new MobileDocumentWorkingCopy(
			resource,
			model,
			await this.readPersistedContent(path),
			async () => {
				await fs.writeFile(path, model.getValue(), 'utf8');
			},
			() => this.readPersistedContent(path)
		);
		const unregisterWorkingCopy = this.workingCopyService.registerWorkingCopy(workingCopy);
		const session: RuntimeDocumentSession = {
			path,
			resource,
			version,
			model,
			workingCopy,
			unregisterWorkingCopy,
		};
		this.sessions.set(path, session);
		return { ok: true, snapshot: this.snapshotOf(session) };
	}

	async changeDocument(arg: any): Promise<RuntimeDocumentCommandResponse> {
		const path = this.requirePath(arg?.path);
		const version = this.requireVersion(arg?.version);
		const rawChanges = Array.isArray(arg?.changes) ? arg.changes : [];
		if (rawChanges.length === 0) {
			throw new RuntimeDocumentError('invalid_request', 'at least one document change is required');
		}

		const session = this.requireSession(path);
		if (version <= session.version) {
			throw new RuntimeDocumentError('version_conflict', 'document version is stale');
		}

		for (const rawChange of rawChanges as RuntimeDocumentChange[]) {
			this.applyChange(session.model, rawChange);
		}

		session.version = version;
		return { ok: true, snapshot: this.snapshotOf(session) };
	}

	async saveDocument(arg: any): Promise<RuntimeDocumentCommandResponse> {
		const session = this.requireSession(this.requirePath(arg?.path));
		try {
			await session.workingCopy.save();
		} catch (err) {
			throw new RuntimeDocumentError('document_save_failed', `failed to save document: ${session.path}`);
		}
		return { ok: true, snapshot: this.snapshotOf(session) };
	}

	async closeDocument(arg: any): Promise<RuntimeDocumentCommandResponse> {
		const path = this.requirePath(arg?.path);
		const session = this.requireSession(path);
		this.sessions.delete(path);
		session.unregisterWorkingCopy.dispose();
		session.workingCopy.dispose();
		this.modelService.destroyModel(session.resource);
		return { ok: true, path, closed: true };
	}

	async snapshotDocument(arg: any): Promise<RuntimeDocumentCommandResponse> {
		const session = this.requireSession(this.requirePath(arg?.path));
		return { ok: true, snapshot: this.snapshotOf(session) };
	}

	peek(path: string): RuntimeDocumentSnapshot | undefined {
		const session = this.sessions.get(path);
		return session ? this.snapshotOf(session) : undefined;
	}

	private snapshotOf(session: RuntimeDocumentSession): RuntimeDocumentSnapshot {
		return {
			path: session.path,
			version: session.version,
			content: session.model.getValue(),
		};
	}

	private requireSession(path: string): RuntimeDocumentSession {
		const session = this.sessions.get(path);
		if (!session) {
			throw new RuntimeDocumentError('document_not_open', 'document is not open');
		}
		return session;
	}

	private requirePath(path: unknown): string {
		if (typeof path !== 'string' || path.trim().length === 0) {
			throw new RuntimeDocumentError('invalid_request', 'document path is required');
		}
		return path;
	}

	private requireVersion(version: unknown): number {
		if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
			throw new RuntimeDocumentError('invalid_request', 'document version must be zero or greater');
		}
		return version;
	}

	private reconcileOpen(session: RuntimeDocumentSession, version: number, content: string | undefined): RuntimeDocumentSnapshot {
		const current = this.snapshotOf(session);
		if (version < session.version) {
			throw new RuntimeDocumentError('version_conflict', 'document version is stale');
		}
		if (version === session.version) {
			if (content === undefined || content === current.content) {
				return current;
			}
			throw new RuntimeDocumentError('version_conflict', 'document reopen conflicts with tracked buffer');
		}
		if (content === undefined) {
			throw new RuntimeDocumentError('version_conflict', 'document reopen requires content for a newer version');
		}
		session.workingCopy.replaceModelContents(content);
		session.version = version;
		return this.snapshotOf(session);
	}

	private applyChange(model: ITextModel, change: RuntimeDocumentChange): void {
		if (!change.range) {
			model.setValue(change.text);
			return;
		}

		const start = this.toModelRangeBoundary(model, change.range.start);
		const end = this.toModelRangeBoundary(model, change.range.end);
		const range = new Range(start.lineNumber, start.column, end.lineNumber, end.column);
		if (range.getEndPosition().isBefore(range.getStartPosition())) {
			throw new RuntimeDocumentError('invalid_position', 'document range end precedes start');
		}
		model.applyEdits([{ range, text: change.text }]);
	}

	private toModelRangeBoundary(model: ITextModel, pos: RuntimeDocumentPosition): { lineNumber: number; column: number } {
		if (!Number.isInteger(pos.line) || !Number.isInteger(pos.character) || pos.line < 0 || pos.character < 0) {
			throw new RuntimeDocumentError('invalid_position', 'document position must be zero or greater');
		}

		const lineNumber = pos.line + 1;
		if (lineNumber < 1 || lineNumber > model.getLineCount()) {
			throw new RuntimeDocumentError('invalid_position', 'document position line is out of range');
		}

		const maxColumn = model.getLineMaxColumn(lineNumber);
		const column = pos.character + 1;
		if (column < 1 || column > maxColumn) {
			throw new RuntimeDocumentError('invalid_position', 'document position character is out of range');
		}

		return { lineNumber, column };
	}

	private async readFileForOpen(path: string): Promise<string> {
		try {
			return await fs.readFile(path, 'utf8');
		} catch (err) {
			throw new RuntimeDocumentError('document_load_failed', `failed to load document content: ${path}`);
		}
	}

	private async readPersistedContent(path: string): Promise<string> {
		try {
			return await fs.readFile(path, 'utf8');
		} catch (err) {
			return '';
		}
	}
}

export class MobileDocumentsChannel implements IServerChannel<RemoteAgentConnectionContext> {
	constructor(
		private readonly _logService: ILogService,
		private readonly documents: MobileRuntimeDocumentService
	) { }

	call<T>(_ctx: RemoteAgentConnectionContext, command: string, arg?: any): Promise<T> {
		this._logService.trace(`[MobileDocumentsChannel] ${command}`, arg);
		switch (command) {
			case 'open':
				return this.withResponse(() => this.documents.openDocument(arg)) as Promise<T>;
			case 'change':
				return this.withResponse(() => this.documents.changeDocument(arg)) as Promise<T>;
			case 'save':
				return this.withResponse(() => this.documents.saveDocument(arg)) as Promise<T>;
			case 'close':
				return this.withResponse(() => this.documents.closeDocument(arg)) as Promise<T>;
			case 'snapshot':
				return this.withResponse(() => this.documents.snapshotDocument(arg)) as Promise<T>;
		}
		throw new Error(`Command not found: ${command}`);
	}

	listen<T>(_ctx: RemoteAgentConnectionContext, event: string, _arg?: any): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	private async withResponse(action: () => Promise<RuntimeDocumentCommandResponse>): Promise<RuntimeDocumentCommandResponse> {
		try {
			return await action();
		} catch (err) {
			if (err instanceof RuntimeDocumentError) {
				return {
					ok: false,
					error: {
						code: err.code,
						message: err.message,
					},
				};
			}
			const message = err instanceof Error ? err.message : 'runtime document command failed';
			return {
				ok: false,
				error: {
					code: 'document_sync_failed',
					message,
				},
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Editor channel (runtime model backed MVP)
// ---------------------------------------------------------------------------

interface EditorRequest {
	path: string;
	version: number;
	content?: string;
	position?: { line: number; character: number };
	range?: { start: { line: number; character: number }; end: { line: number; character: number } };
	newName?: string;
	workDir?: string;
	context?: Record<string, any>;
	options?: Record<string, any>;
	query?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isPositionShape(value: unknown): value is { line?: number; character?: number; lineNumber?: number; column?: number } {
	return isObject(value) && (
		(typeof value.line === 'number' && typeof value.character === 'number')
		|| (typeof value.lineNumber === 'number' && typeof value.column === 'number')
	);
}

function isRangeShape(value: unknown): value is {
	start?: unknown;
	end?: unknown;
	startLineNumber?: number;
	startColumn?: number;
	endLineNumber?: number;
	endColumn?: number;
} {
	return isObject(value) && (
		(isPositionShape(value.start) && isPositionShape(value.end))
		|| (
			typeof value.startLineNumber === 'number'
			&& typeof value.startColumn === 'number'
			&& typeof value.endLineNumber === 'number'
			&& typeof value.endColumn === 'number'
		)
	);
}

function normalizePosition(value: unknown): { line: number; character: number } | undefined {
	if (!isPositionShape(value)) {
		return undefined;
	}
	if (typeof value.line === 'number' && typeof value.character === 'number') {
		return { line: value.line, character: value.character };
	}
	if (typeof value.lineNumber === 'number' && typeof value.column === 'number') {
		return { line: value.lineNumber - 1, character: value.column - 1 };
	}
	return undefined;
}

function normalizeRange(value: unknown): { start: { line: number; character: number }; end: { line: number; character: number } } | undefined {
	if (!isRangeShape(value)) {
		return undefined;
	}
	if (isPositionShape(value.start) && isPositionShape(value.end)) {
		const start = normalizePosition(value.start);
		const end = normalizePosition(value.end);
		if (start && end) {
			return { start, end };
		}
	}
	if (
		typeof value.startLineNumber === 'number'
		&& typeof value.startColumn === 'number'
		&& typeof value.endLineNumber === 'number'
		&& typeof value.endColumn === 'number'
	) {
		return {
			start: { line: value.startLineNumber - 1, character: value.startColumn - 1 },
			end: { line: value.endLineNumber - 1, character: value.endColumn - 1 },
		};
	}
	return undefined;
}

function toRuntimePosition(position: { line: number; character: number } | undefined): { lineNumber: number; column: number } {
	return {
		lineNumber: (position?.line ?? 0) + 1,
		column: (position?.character ?? 0) + 1,
	};
}

function toRuntimeRange(range: EditorRequest['range']): Range {
	const start = toRuntimePosition(range?.start);
	const end = toRuntimePosition(range?.end);
	return new Range(start.lineNumber, start.column, end.lineNumber, end.column);
}

function normalizeUri(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (URI.isUri(value)) {
		return value.toString();
	}
	if (isObject(value) && typeof value.path === 'string') {
		const scheme = typeof value.scheme === 'string' ? value.scheme : 'file';
		return `${scheme}://${value.path}`;
	}
	return '';
}

function normalizePath(value: unknown): string {
	if (URI.isUri(value)) {
		return value.scheme === 'file' ? value.fsPath : value.path;
	}
	if (typeof value === 'string') {
		if (value.startsWith('file://')) {
			try {
				return URI.parse(value).fsPath;
			} catch {
				return value;
			}
		}
		return value;
	}
	if (isObject(value) && typeof value.path === 'string') {
		return value.path;
	}
	return '';
}

function normalizeMarkup(value: unknown): unknown {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(item => normalizeMarkup(item)).filter(item => item !== undefined);
	}
	if (URI.isUri(value)) {
		return value.toString();
	}
	if (isRangeShape(value)) {
		return normalizeRange(value);
	}
	if (isPositionShape(value)) {
		return normalizePosition(value);
	}
	if (!isObject(value)) {
		return String(value);
	}
	if (typeof value.value === 'string' && typeof value.language === 'string') {
		return { value: value.value, language: value.language };
	}
	if (typeof value.value === 'string') {
		return { kind: typeof value.isTrusted === 'boolean' ? 'markdown' : (typeof value.kind === 'string' ? value.kind : 'markdown'), value: value.value };
	}
	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		result[key] = normalizeMarkup(nested);
	}
	return result;
}

function normalizeTextEdit(value: unknown): Record<string, unknown> | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const newText = typeof value.newText === 'string' ? value.newText : (typeof value.text === 'string' ? value.text : '');
	const range = normalizeRange(value.range);
	if (range) {
		return { range, newText };
	}
	const insert = normalizeRange(value.insert);
	const replace = normalizeRange(value.replace);
	if (insert || replace) {
		return {
			insert,
			replace,
			newText,
		};
	}
	if (isRangeShape(value)) {
		const lifted = normalizeRange(value);
		if (lifted) {
			return { range: lifted, newText };
		}
	}
	return undefined;
}

function normalizeCommand(value: unknown): Record<string, unknown> | undefined {
	if (!isObject(value) || typeof value.id !== 'string') {
		return undefined;
	}
	return {
		id: value.id,
		title: typeof value.title === 'string' ? value.title : value.id,
		arguments: Array.isArray(value.arguments) ? value.arguments.map(arg => normalizeMarkup(arg)) : undefined,
	};
}

function normalizeCompletionItem(value: unknown): Record<string, unknown> {
	const item = isObject(value) ? value : {};
	const insertText = typeof item.insertText === 'string' ? item.insertText : (typeof item.label === 'string' ? item.label : '');
	const textEdit = normalizeTextEdit(item.textEdit)
		?? normalizeTextEdit({
			range: item.range,
			text: insertText,
		});
	const insertTextRules = typeof item.insertTextRules === 'number' ? item.insertTextRules : 0;
	return {
		label: normalizeMarkup(item.label),
		kind: item.kind,
		detail: typeof item.detail === 'string' ? item.detail : '',
		documentation: normalizeMarkup(item.documentation),
		sortText: typeof item.sortText === 'string' ? item.sortText : undefined,
		filterText: typeof item.filterText === 'string' ? item.filterText : undefined,
		insertText,
		insertTextFormat: (insertTextRules & 0b100) !== 0 ? 2 : 1,
		textEdit,
		additionalTextEdits: Array.isArray(item.additionalTextEdits) ? item.additionalTextEdits.map(edit => normalizeTextEdit(edit)).filter(Boolean) : [],
		command: normalizeCommand(item.command ?? item.action),
		data: normalizeMarkup(item.data),
	};
}

function normalizeCompletionList(value: unknown): { isIncomplete: boolean; items: Record<string, unknown>[] } {
	const list = isObject(value) ? value : {};
	const rawItems = Array.isArray(list.items) ? list.items : (Array.isArray(list.suggestions) ? list.suggestions : []);
	return {
		isIncomplete: list.isIncomplete === true || list.incomplete === true,
		items: rawItems.map(item => normalizeCompletionItem(item)),
	};
}

function normalizeHoverList(value: unknown): { contents: unknown; range?: unknown } {
	const hovers = Array.isArray(value) ? value.filter(isObject) : [];
	if (hovers.length === 0) {
		return { contents: '' };
	}
	const contents = hovers.flatMap(hover => Array.isArray(hover.contents) ? hover.contents.map(item => normalizeMarkup(item)) : []);
	const firstRange = hovers.map(hover => normalizeRange(hover.range)).find(Boolean);
	return {
		contents: contents.length <= 1 ? (contents[0] ?? '') : contents,
		range: firstRange,
	};
}

function normalizeLocations(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map(entry => {
		const item = isObject(entry) ? entry : {};
		const uri = normalizeUri(item.uri);
		const path = normalizePath(item.uri);
		const range = normalizeRange(item.targetSelectionRange ?? item.range) ?? {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 0 },
		};
		return { uri, path, range };
	});
}

function normalizeSignatureHelp(value: unknown): Record<string, unknown> {
	if (!isObject(value)) {
		return {};
	}
	const signatures = Array.isArray(value.signatures) ? value.signatures : [];
	return {
		signatures: signatures.map(signature => {
			const item = isObject(signature) ? signature : {};
			return {
				label: typeof item.label === 'string' ? item.label : '',
				documentation: normalizeMarkup(item.documentation),
				parameters: Array.isArray(item.parameters) ? item.parameters.map(parameter => normalizeMarkup(parameter)) : undefined,
			};
		}),
		activeSignature: typeof value.activeSignature === 'number' ? value.activeSignature : 0,
		activeParameter: typeof value.activeParameter === 'number' ? value.activeParameter : 0,
	};
}

function normalizeDocumentSymbol(value: unknown): Record<string, unknown> | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const range = normalizeRange(value.range);
	const selectionRange = normalizeRange(value.selectionRange) ?? range;
	if (!range || !selectionRange) {
		return undefined;
	}
	return {
		name: typeof value.name === 'string' ? value.name : '',
		detail: typeof value.detail === 'string' ? value.detail : '',
		kind: typeof value.kind === 'number' ? value.kind : 13,
		tags: Array.isArray(value.tags) ? value.tags : undefined,
		deprecated: value.deprecated === true,
		range,
		selectionRange,
		children: Array.isArray(value.children) ? value.children.map(child => normalizeDocumentSymbol(child)).filter(Boolean) : [],
	};
}

function normalizeDocumentSymbols(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map(symbol => normalizeDocumentSymbol(symbol)).filter(Boolean) as Array<Record<string, unknown>>;
}

function normalizeWorkspaceEdit(value: unknown): Record<string, unknown> {
	if (!isObject(value)) {
		return { changes: {} };
	}
	const changes: Record<string, unknown[]> = {};
	const documentChanges: Record<string, unknown>[] = [];

	const edits = Array.isArray(value.edits) ? value.edits : [];
	for (const entry of edits) {
		if (!isObject(entry)) {
			continue;
		}
		if (entry.resource) {
			const uri = normalizeUri(entry.resource);
			const edit = normalizeTextEdit(entry.textEdit);
			if (!uri || !edit) {
				continue;
			}
			const bucket = changes[uri] ?? [];
			bucket.push(edit);
			changes[uri] = bucket;
			continue;
		}
		if (entry.newResource || entry.oldResource) {
			documentChanges.push(normalizeMarkup(entry) as Record<string, unknown>);
		}
	}

	for (const [uri, textEdits] of Object.entries(changes)) {
		documentChanges.push({
			textDocument: { uri },
			edits: textEdits,
		});
	}

	return {
		changes,
		documentChanges,
	};
}

function normalizeCodeAction(value: unknown): Record<string, unknown> | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	return {
		title: typeof value.title === 'string' ? value.title : 'Untitled action',
		kind: typeof value.kind === 'string' ? value.kind : '',
		edit: normalizeWorkspaceEdit(value.edit),
		command: normalizeCommand(value.command),
		diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics.map(diagnostic => normalizeMarkup(diagnostic)) : undefined,
		isPreferred: value.isPreferred === true,
		disabled: typeof value.disabled === 'string' ? value.disabled : undefined,
	};
}

function normalizeCodeActions(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map(action => normalizeCodeAction(action)).filter(Boolean) as Array<Record<string, unknown>>;
}

export class MobileEditorChannel implements IServerChannel<RemoteAgentConnectionContext> {
	constructor(
		private readonly _logService: ILogService,
		private readonly documents: MobileRuntimeDocumentService,
		private readonly commandService: ICommandService,
		private readonly markerService: IMarkerService
	) { }

	async call<T>(_ctx: RemoteAgentConnectionContext, command: string, arg?: any): Promise<T> {
		this._logService.trace(`[MobileEditorChannel] ${command}`, arg);
		const req = arg as EditorRequest;
		switch (command) {
			case 'diagnostics':
				return this.runtimeDiagnostics(req) as T;
			case 'completion':
				return (await this.runtimeCompletion(req)) as T;
			case 'hover':
				return (await this.runtimeHover(req)) as T;
			case 'definition':
				return (await this.runtimeDefinition(req)) as T;
			case 'references':
				return (await this.runtimeReferences(req)) as T;
			case 'signatureHelp':
				return (await this.runtimeSignatureHelp(req)) as T;
			case 'formatting':
				return (await this.runtimeFormatting(req)) as T;
			case 'codeActions':
				return (await this.runtimeCodeActions(req)) as T;
			case 'rename':
				return (await this.runtimeRename(req)) as T;
			case 'documentSymbols':
				return (await this.runtimeDocumentSymbols(req)) as T;
		}
		throw new Error(`Command not found: ${command}`);
	}

	listen<T>(_ctx: RemoteAgentConnectionContext, event: string, _arg?: any): Event<T> {
		switch (event) {
			case 'diagnosticsChanged':
				return this.runtimeDiagnosticsChanged() as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	private runtimeDiagnostics(req: EditorRequest | undefined): { path: string; version: number; diagnostics: unknown[] } {
		const path = req?.path ?? '';
		const snapshot = path ? this.documents.peek(path) : undefined;
		const resource = snapshot ? URI.file(snapshot.path) : (path ? URI.file(path) : undefined);
		return {
			path: snapshot?.path ?? path,
			version: snapshot?.version ?? req?.version ?? 0,
			diagnostics: resource ? this.markerService.read({ resource }).map(marker => this.normalizeMarker(marker)) : [],
		};
	}

	private runtimeDiagnosticsChanged(): Event<unknown> {
		return (listener, thisArgs = null, disposables?) => this.markerService.onMarkerChanged(resources => {
			for (const resource of resources) {
				if (resource.scheme !== 'file') {
					continue;
				}
				const payload = this.runtimeDiagnosticsForPath(resource.fsPath);
				if (payload) {
					listener.call(thisArgs, payload);
				}
			}
		}, undefined, disposables);
	}

	private runtimeDiagnosticsForPath(path: string): { path: string; version: number; diagnostics: unknown[] } | undefined {
		const snapshot = this.documents.peek(path);
		if (!snapshot) {
			return undefined;
		}
		return this.runtimeDiagnostics({ path, version: snapshot.version });
	}

	private async runtimeCompletion(req: EditorRequest | undefined): Promise<{ isIncomplete: boolean; items: Record<string, unknown>[] }> {
		const resource = this.requireResource(req);
		const result = await this.commandService.executeCommand('_executeCompletionItemProvider', resource, toRuntimePosition(req?.position), this.triggerCharacter(req), this.resolveCount(req));
		return normalizeCompletionList(result);
	}

	private async runtimeHover(req: EditorRequest | undefined): Promise<{ contents: unknown; range?: unknown }> {
		const resource = this.requireResource(req);
		const result = await this.commandService.executeCommand('_executeHoverProvider', resource, toRuntimePosition(req?.position));
		return normalizeHoverList(result);
	}

	private async runtimeDefinition(req: EditorRequest | undefined): Promise<Array<Record<string, unknown>>> {
		const resource = this.requireResource(req);
		const result = await this.commandService.executeCommand('_executeDefinitionProvider', resource, toRuntimePosition(req?.position));
		return normalizeLocations(result);
	}

	private async runtimeReferences(req: EditorRequest | undefined): Promise<Array<Record<string, unknown>>> {
		const resource = this.requireResource(req);
		const result = await this.commandService.executeCommand('_executeReferenceProvider', resource, toRuntimePosition(req?.position));
		return normalizeLocations(result);
	}

	private async runtimeSignatureHelp(req: EditorRequest | undefined): Promise<Record<string, unknown>> {
		const resource = this.requireResource(req);
		const result = await this.commandService.executeCommand('_executeSignatureHelpProvider', resource, toRuntimePosition(req?.position), this.triggerCharacter(req));
		return normalizeSignatureHelp(result);
	}

	private async runtimeFormatting(req: EditorRequest | undefined): Promise<Array<Record<string, unknown>>> {
		const resource = this.requireResource(req);
		const result = await this.commandService.executeCommand('_executeFormatDocumentProvider', resource, req?.options);
		return Array.isArray(result) ? result.map(edit => normalizeTextEdit(edit)).filter(Boolean) as Array<Record<string, unknown>> : [];
	}

	private async runtimeCodeActions(req: EditorRequest | undefined): Promise<Array<Record<string, unknown>>> {
		const resource = this.requireResource(req);
		const result = await this.commandService.executeCommand('_executeCodeActionProvider', resource, toRuntimeRange(req?.range), this.codeActionKind(req), this.resolveCount(req));
		return normalizeCodeActions(result);
	}

	private async runtimeRename(req: EditorRequest | undefined): Promise<Record<string, unknown>> {
		const resource = this.requireResource(req);
		const result = await this.commandService.executeCommand('_executeDocumentRenameProvider', resource, toRuntimePosition(req?.position), req?.newName ?? '');
		return normalizeWorkspaceEdit(result);
	}

	private async runtimeDocumentSymbols(req: EditorRequest | undefined): Promise<Array<Record<string, unknown>>> {
		const resource = this.requireResource(req);
		const result = await this.commandService.executeCommand('_executeDocumentSymbolProvider', resource);
		return normalizeDocumentSymbols(result);
	}

	private requireResource(req: EditorRequest | undefined): URI {
		const path = req?.path ?? '';
		return URI.file(path);
	}

	private triggerCharacter(req: EditorRequest | undefined): string | undefined {
		const trigger = req?.context?.triggerCharacter;
		return typeof trigger === 'string' && trigger.length > 0 ? trigger : undefined;
	}

	private resolveCount(req: EditorRequest | undefined): number | undefined {
		const candidate = req?.context?.resolveCount ?? req?.options?.resolveCount;
		return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
	}

	private codeActionKind(req: EditorRequest | undefined): string | undefined {
		const candidate = req?.context?.only;
		return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
	}

	private normalizeMarker(marker: unknown): Record<string, unknown> {
		const value = isObject(marker) ? marker : {};
		return {
			range: {
				start: {
					line: ((value.startLineNumber as number | undefined) ?? 1) - 1,
					character: ((value.startColumn as number | undefined) ?? 1) - 1,
				},
				end: {
					line: ((value.endLineNumber as number | undefined) ?? 1) - 1,
					character: ((value.endColumn as number | undefined) ?? 1) - 1,
				},
			},
			severity: this.normalizeMarkerSeverity(value.severity),
			code: normalizeMarkup(value.code),
			source: typeof value.source === 'string' ? value.source : undefined,
			message: typeof value.message === 'string' ? value.message : '',
			tags: Array.isArray(value.tags) ? value.tags : undefined,
			relatedInformation: normalizeMarkup(value.relatedInformation),
		};
	}

	private normalizeMarkerSeverity(value: unknown): number | undefined {
		switch (value) {
			case MarkerSeverity.Error:
				return 1;
			case MarkerSeverity.Warning:
				return 2;
			case MarkerSeverity.Info:
				return 3;
			case MarkerSeverity.Hint:
				return 4;
			default:
				return undefined;
		}
	}
}
