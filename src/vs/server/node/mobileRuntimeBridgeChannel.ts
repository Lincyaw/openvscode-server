/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
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
import { ILogService } from '../../platform/log/common/log.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../platform/markers/common/markers.js';
import { Progress } from '../../platform/progress/common/progress.js';
import { RemoteAgentConnectionContext } from '../../platform/remote/common/remoteAgentEnvironment.js';
import { IResolvedTextFileEditorModel, ITextFileEditorModel, ITextFileService } from '../../workbench/services/textfile/common/textfiles.js';

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
					enabled: false,
					push: false,
					pull: false,
					fetch: false,
					conflicts: false,
					aheadBehind: false,
					reason: 'Source Control runtime bridge is not implemented yet.',
				},
				terminal: {
					enabled: false,
					persistentSessions: false,
					split: false,
					commandDetection: false,
					reason: 'Terminal runtime bridge is not implemented yet.',
				},
				workspace: {
					enabled: false,
					search: false,
					symbols: false,
					folders: false,
					problems: false,
					reason: 'Workspace intelligence bridge is not implemented yet.',
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
}

interface GitDiffDocument {
	path: string;
	diff: string;
	staged: boolean;
}

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, { cwd });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
		child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
		child.on('close', (code) => {
			resolve({ stdout, stderr, code: code ?? 0 });
		});
		child.on('error', (err) => reject(err));
	});
}

async function getRepositoryState(path: string): Promise<GitRepositoryDocument> {
	// branch and upstream
	const branchResult = await runGit(path, ['branch', '-vv']);
	let branch = '';
	let upstream = '';
	for (const line of branchResult.stdout.split('\n')) {
		const m = line.match(/^\*\s+(\S+)\s+(?:\[([^\]]+)\])?/);
		if (m) {
			branch = m[1];
			if (m[2]) {
				const upParts = m[2].split(/[:\s]/);
				upstream = upParts[0];
			}
			break;
		}
	}

	// ahead/behind
	let ahead = 0;
	let behind = 0;
	if (upstream) {
		try {
			const revResult = await runGit(path, ['rev-list', '--left-right', '--count', `HEAD...@{upstream}`]);
			const parts = revResult.stdout.trim().split(/\s+/);
			if (parts.length === 2) {
				ahead = parseInt(parts[0], 10) || 0;
				behind = parseInt(parts[1], 10) || 0;
			}
		} catch (_) {
			// ignore
		}
	}

	// remotes
	const remoteResult = await runGit(path, ['remote', '-v']);
	const remotes: GitRemote[] = [];
	const seenRemotes = new Set<string>();
	for (const line of remoteResult.stdout.split('\n')) {
		const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
		if (!m) { continue; }
		const name = m[1];
		const url = m[2];
		const kind = m[3];
		if (seenRemotes.has(name)) {
			const r = remotes.find(r => r.name === name);
			if (r) {
				if (kind === 'fetch') { r.fetchUrl = url; }
				if (kind === 'push') { r.pushUrl = url; }
			}
		} else {
			seenRemotes.add(name);
			remotes.push({
				name,
				fetchUrl: kind === 'fetch' ? url : undefined,
				pushUrl: kind === 'push' ? url : undefined,
			});
		}
	}

	// status
	const statusResult = await runGit(path, ['status', '--porcelain', '-uall']);
	const staged: GitChange[] = [];
	const unstaged: GitChange[] = [];
	const untracked: GitChange[] = [];
	const conflicts: GitChange[] = [];

	for (const line of statusResult.stdout.split('\n')) {
		if (line.length < 2) { continue; }
		const index = line[0];
		const workTree = line[1];
		const rest = line.slice(3).trim();
		const filePath = rest.split(' -> ').pop() ?? rest;

		if (index === 'U' || workTree === 'U' || (index === 'D' && workTree === 'D') || (index === 'A' && workTree === 'A')) {
			conflicts.push({ path: filePath, status: 'conflict' });
		} else if (index === '?' && workTree === '?') {
			untracked.push({ path: filePath, status: 'untracked' });
		} else if (index !== ' ' && index !== '?') {
			staged.push({ path: filePath, indexStatus: index, status: mapGitStatus(index) });
		}

		if (workTree !== ' ' && workTree !== '?') {
			unstaged.push({ path: filePath, workingTreeStatus: workTree, status: mapGitStatus(workTree) });
		}
	}

	return {
		path,
		branch,
		upstream,
		ahead,
		behind,
		remotes,
		staged,
		unstaged,
		untracked,
		conflicts,
		mergeChanges: [],
	};
}

function mapGitStatus(code: string): string {
	switch (code) {
		case 'M': return 'modified';
		case 'A': return 'added';
		case 'D': return 'deleted';
		case 'R': return 'renamed';
		case 'C': return 'copied';
		case 'U': return 'updated';
		case '?': return 'untracked';
		default: return 'unknown';
	}
}

export class MobileGitChannel implements IServerChannel<RemoteAgentConnectionContext> {
	private readonly _onRepositoryChanged = new Emitter<{ path: string; repository: GitRepositoryDocument }>();
	readonly onRepositoryChanged = this._onRepositoryChanged.event;
	private readonly watchers = new Map<string, NodeJS.Timeout>();

	constructor(private readonly _logService: ILogService) { }

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
		return getRepositoryState(path);
	}

	private async stage(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const files = (arg?.files as string[]) ?? [];
		if (!path) { throw new Error('path is required'); }
		await runGit(path, ['add', ...files]);
		return getRepositoryState(path);
	}

	private async unstage(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const files = (arg?.files as string[]) ?? [];
		if (!path) { throw new Error('path is required'); }
		await runGit(path, ['reset', 'HEAD', ...files]);
		return getRepositoryState(path);
	}

	private async commit(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const message = arg?.message as string;
		if (!path) { throw new Error('path is required'); }
		if (!message) { throw new Error('message is required'); }
		await runGit(path, ['commit', '-m', message]);
		return getRepositoryState(path);
	}

	private async checkout(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const ref = arg?.ref as string;
		const create = arg?.create as boolean;
		if (!path) { throw new Error('path is required'); }
		if (!ref) { throw new Error('ref is required'); }
		const args = create ? ['checkout', '-b', ref] : ['checkout', ref];
		await runGit(path, args);
		return getRepositoryState(path);
	}

	private async fetch(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const remote = arg?.remote as string;
		if (!path) { throw new Error('path is required'); }
		const args = remote ? ['fetch', remote] : ['fetch'];
		await runGit(path, args);
		return getRepositoryState(path);
	}

	private async pull(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const remote = arg?.remote as string;
		const branch = arg?.branch as string;
		if (!path) { throw new Error('path is required'); }
		const args = ['pull'];
		if (remote) { args.push(remote); }
		if (branch) { args.push(branch); }
		await runGit(path, args);
		return getRepositoryState(path);
	}

	private async push(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const remote = arg?.remote as string;
		const branch = arg?.branch as string;
		const setUpstream = arg?.setUpstream as boolean;
		if (!path) { throw new Error('path is required'); }
		const args = ['push'];
		if (setUpstream) { args.push('--set-upstream'); }
		if (remote) { args.push(remote); }
		if (branch) { args.push(branch); }
		await runGit(path, args);
		return getRepositoryState(path);
	}

	private async discard(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const files = (arg?.files as string[]) ?? [];
		if (!path) { throw new Error('path is required'); }
		await runGit(path, ['checkout', '--', ...files]);
		return getRepositoryState(path);
	}

	private async diff(arg: any): Promise<GitDiffDocument> {
		const path = arg?.path as string;
		const file = arg?.file as string;
		const staged = arg?.staged as boolean;
		if (!path) { throw new Error('path is required'); }
		if (!file) { throw new Error('file is required'); }
		const args = staged ? ['diff', '--staged', '--', file] : ['diff', '--', file];
		const result = await runGit(path, args);
		return { path: file, diff: result.stdout, staged: !!staged };
	}

	private async stash(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const message = arg?.message as string;
		const includeUntracked = arg?.includeUntracked as boolean;
		if (!path) { throw new Error('path is required'); }
		const args = ['stash', 'push'];
		if (message) { args.push('-m', message); }
		if (includeUntracked) { args.push('-u'); }
		await runGit(path, args);
		return getRepositoryState(path);
	}

	private async stashApply(arg: any): Promise<GitRepositoryDocument> {
		const path = arg?.path as string;
		const stashRef = arg?.stash as string;
		const pop = arg?.pop as boolean;
		if (!path) { throw new Error('path is required'); }
		const args = pop ? ['stash', 'pop'] : ['stash', 'apply'];
		if (stashRef) { args.push(stashRef); }
		await runGit(path, args);
		return getRepositoryState(path);
	}

	private subscribeRepositoryChanged(path: string | undefined): Event<any> {
		if (!path) { return Event.None; }

		const emitter = new Emitter<GitRepositoryDocument>();
		const interval: ReturnType<typeof setInterval> = setInterval(async () => {
			try {
				const repo = await getRepositoryState(path);
				emitter.fire(repo);
			} catch (_) {
				// ignore polling errors
			}
		}, 2000);

		this.watchers.set(path, interval as any);
		return emitter.event;
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
