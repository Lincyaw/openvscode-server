/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Event, Emitter } from '../../base/common/event.js';
import { IServerChannel } from '../../base/parts/ipc/common/ipc.js';
import { RemoteAgentConnectionContext } from '../../platform/remote/common/remoteAgentEnvironment.js';
import { ILogService } from '../../platform/log/common/log.js';

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
				git: { enabled: true },
				terminal: { enabled: true },
				files: { enabled: true },
				diagnostics: { enabled: true },
				editor: { enabled: true },
				completion: { enabled: false },
				hover: { enabled: false },
				definition: { enabled: false },
				references: { enabled: false },
				signatureHelp: { enabled: false },
				formatting: { enabled: false },
				codeActions: { enabled: false },
				rename: { enabled: false },
				documentSymbols: { enabled: false },
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
// Editor channel (MVP - empty responses)
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

export class MobileEditorChannel implements IServerChannel<RemoteAgentConnectionContext> {
	constructor(private readonly _logService: ILogService) { }

	call(_ctx: RemoteAgentConnectionContext, command: string, arg?: any): Promise<any> {
		this._logService.trace(`[MobileEditorChannel] ${command}`, arg);
		const req = arg as EditorRequest;
		switch (command) {
			case 'diagnostics':
				return Promise.resolve({ path: req?.path ?? '', version: req?.version ?? 0, diagnostics: [] });
			case 'completion':
				return Promise.resolve({ isIncomplete: false, items: [] });
			case 'hover':
				return Promise.resolve({ contents: '' });
			case 'definition':
				return Promise.resolve([]);
			case 'references':
				return Promise.resolve([]);
			case 'signatureHelp':
				return Promise.resolve({});
			case 'formatting':
				return Promise.resolve([]);
			case 'codeActions':
				return Promise.resolve([]);
			case 'rename':
				return Promise.resolve({ changes: {} });
			case 'documentSymbols':
				return Promise.resolve([]);
		}
		throw new Error(`Command not found: ${command}`);
	}

	listen(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
		switch (event) {
			case 'diagnosticsChanged':
				return Event.None;
		}
		throw new Error(`Event not found: ${event}`);
	}
}
