/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { commands, Disposable, Uri } from 'vscode';
import { Model } from './model';
import { Repository as BaseRepository, Resource, ResourceGroupType } from './repository';
import { Branch, Remote, Status } from './api/git';

interface GitBridgeHead {
	name?: string;
	commit?: string;
	upstream?: {
		remote: string;
		name: string;
	};
	ahead: number;
	behind: number;
}

interface GitBridgeRemote {
	name: string;
	fetchUrl?: string;
	pushUrl?: string;
	isReadOnly: boolean;
}

interface GitBridgeChange {
	path: string;
	originalPath?: string;
	status: string;
	indexStatus?: string;
	workingTreeStatus?: string;
	mergeStatus?: {
		kind: string;
		current?: string;
		incoming?: string;
	};
}

interface GitBridgeRepositoryState {
	path: string;
	head?: GitBridgeHead;
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	remotes: GitBridgeRemote[];
	staged: GitBridgeChange[];
	unstaged: GitBridgeChange[];
	untracked: GitBridgeChange[];
	conflicts: GitBridgeChange[];
	mergeChanges: GitBridgeChange[];
}

function toUri(uriOrPath: string): Uri {
	if (uriOrPath.startsWith('file://')) {
		return Uri.parse(uriOrPath);
	}
	return Uri.file(uriOrPath);
}

async function getRepository(model: Model, uriOrPath: string): Promise<BaseRepository> {
	const uri = toUri(uriOrPath);
	await model.openRepository(uri.fsPath, true, true);
	const repository = model.getRepository(uri);
	if (!repository) {
		throw new Error(`git repository not available for ${uri.fsPath}`);
	}
	return repository;
}

function relativePath(repository: BaseRepository, resourcePath: string): string {
	const rel = path.relative(repository.root, resourcePath);
	return rel === '' ? path.basename(resourcePath) : rel.replace(/\\/g, '/');
}

function statusLabel(status: Status): string {
	switch (status) {
		case Status.INDEX_MODIFIED:
		case Status.MODIFIED:
			return 'modified';
		case Status.INDEX_ADDED:
			return 'added';
		case Status.INDEX_DELETED:
		case Status.DELETED:
			return 'deleted';
		case Status.INDEX_RENAMED:
			return 'renamed';
		case Status.INDEX_COPIED:
			return 'copied';
		case Status.UNTRACKED:
			return 'untracked';
		case Status.IGNORED:
			return 'ignored';
		case Status.INTENT_TO_ADD:
			return 'intent_to_add';
		case Status.INTENT_TO_RENAME:
			return 'intent_to_rename';
		case Status.TYPE_CHANGED:
			return 'type_changed';
		case Status.ADDED_BY_US:
			return 'added_by_us';
		case Status.ADDED_BY_THEM:
			return 'added_by_them';
		case Status.DELETED_BY_US:
			return 'deleted_by_us';
		case Status.DELETED_BY_THEM:
			return 'deleted_by_them';
		case Status.BOTH_ADDED:
			return 'both_added';
		case Status.BOTH_DELETED:
			return 'both_deleted';
		case Status.BOTH_MODIFIED:
			return 'both_modified';
	}

	return 'unknown';
}

function mergeStatus(status: Status): GitBridgeChange['mergeStatus'] | undefined {
	switch (status) {
		case Status.ADDED_BY_US:
			return { kind: 'added_by_us' };
		case Status.ADDED_BY_THEM:
			return { kind: 'added_by_them' };
		case Status.DELETED_BY_US:
			return { kind: 'deleted_by_us' };
		case Status.DELETED_BY_THEM:
			return { kind: 'deleted_by_them' };
		case Status.BOTH_ADDED:
			return { kind: 'both_added' };
		case Status.BOTH_DELETED:
			return { kind: 'both_deleted' };
		case Status.BOTH_MODIFIED:
			return { kind: 'both_modified' };
		default:
			return undefined;
	}
}

function serializeChange(repository: BaseRepository, change: Resource): GitBridgeChange {
	return {
		path: relativePath(repository, change.resourceUri.fsPath),
		originalPath: change.renameResourceUri ? relativePath(repository, change.original.fsPath) : undefined,
		status: statusLabel(change.type),
		indexStatus: change.resourceGroupType === ResourceGroupType.Index ? statusLabel(change.type) : undefined,
		workingTreeStatus: change.resourceGroupType === ResourceGroupType.WorkingTree || change.resourceGroupType === ResourceGroupType.Untracked ? statusLabel(change.type) : undefined,
		mergeStatus: mergeStatus(change.type),
	};
}

function serializeHead(head: Branch | undefined): GitBridgeHead | undefined {
	if (!head) {
		return undefined;
	}
	return {
		name: head.name,
		commit: head.commit,
		upstream: head.upstream ? {
			remote: head.upstream.remote,
			name: head.upstream.name,
		} : undefined,
		ahead: head.ahead ?? 0,
		behind: head.behind ?? 0,
	};
}

function serializeRemote(remote: Remote): GitBridgeRemote {
	return {
		name: remote.name,
		fetchUrl: remote.fetchUrl,
		pushUrl: remote.pushUrl,
		isReadOnly: remote.isReadOnly,
	};
}

function serializeRepositoryState(repository: BaseRepository): GitBridgeRepositoryState {
	const head = serializeHead(repository.HEAD);
	return {
		path: repository.root,
		head,
		branch: repository.HEAD?.name,
		upstream: repository.HEAD?.upstream ? `${repository.HEAD.upstream.remote}/${repository.HEAD.upstream.name}` : undefined,
		ahead: repository.HEAD?.ahead ?? 0,
		behind: repository.HEAD?.behind ?? 0,
		remotes: repository.remotes.map(serializeRemote),
		staged: repository.indexGroup.resourceStates.map(change => serializeChange(repository, change)),
		unstaged: repository.workingTreeGroup.resourceStates.map(change => serializeChange(repository, change)),
		untracked: repository.untrackedGroup.resourceStates.map(change => serializeChange(repository, change)),
		conflicts: repository.mergeGroup.resourceStates.map(change => serializeChange(repository, change)),
		mergeChanges: repository.mergeGroup.resourceStates.map(change => serializeChange(repository, change)),
	};
}

function parseStashIndex(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const match = /^stash@\{(\d+)\}$/.exec(value.trim());
	if (!match) {
		return undefined;
	}
	const index = Number(match[1]);
	return Number.isFinite(index) ? index : undefined;
}

export function registerBridgeCommands(model: Model): Disposable {
	const disposables: Disposable[] = [];

	disposables.push(commands.registerCommand('git.bridge.getRepositoryState', async (uriOrPath: string) => {
		const repository = await getRepository(model, uriOrPath);
		await repository.status();
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.diffRepository', async (uriOrPath: string, filePath: string, staged?: boolean) => {
		const repository = await getRepository(model, uriOrPath);
		const diff = staged
			? await repository.diffIndexWithHEAD(filePath)
			: await repository.diffWithHEAD(filePath);
		return {
			path: filePath,
			diff,
			staged: !!staged,
		};
	}));

	disposables.push(commands.registerCommand('git.bridge.stage', async (uriOrPath: string, files: string[]) => {
		const repository = await getRepository(model, uriOrPath);
		await repository.add(files.map(file => Uri.file(path.join(repository.root, file))));
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.unstage', async (uriOrPath: string, files: string[]) => {
		const repository = await getRepository(model, uriOrPath);
		await repository.revert(files.map(file => Uri.file(path.join(repository.root, file))));
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.commit', async (uriOrPath: string, message: string) => {
		const repository = await getRepository(model, uriOrPath);
		repository.inputBox.value = message;
		await repository.commit(message, { postCommitCommand: null });
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.checkout', async (uriOrPath: string, ref: string, create?: boolean) => {
		const repository = await getRepository(model, uriOrPath);
		if (create) {
			await repository.branch(ref, true);
		} else {
			await repository.checkout(ref);
		}
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.fetch', async (uriOrPath: string, remote?: string) => {
		const repository = await getRepository(model, uriOrPath);
		await repository.fetch({ remote });
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.pull', async (uriOrPath: string, remote?: string, branch?: string) => {
		const repository = await getRepository(model, uriOrPath);
		await repository.pullFrom(false, remote, branch);
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.push', async (uriOrPath: string, remote?: string, branch?: string, setUpstream?: boolean) => {
		const repository = await getRepository(model, uriOrPath);
		await repository.pushTo(remote, branch, !!setUpstream);
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.discard', async (uriOrPath: string, files: string[]) => {
		const repository = await getRepository(model, uriOrPath);
		await repository.clean(files.map(file => Uri.file(path.join(repository.root, file))));
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.stash', async (uriOrPath: string, message?: string, includeUntracked?: boolean) => {
		const repository = await getRepository(model, uriOrPath);
		await repository.createStash(message, includeUntracked);
		return serializeRepositoryState(repository);
	}));

	disposables.push(commands.registerCommand('git.bridge.stashApply', async (uriOrPath: string, stash?: string, pop?: boolean) => {
		const repository = await getRepository(model, uriOrPath);
		const index = parseStashIndex(stash);
		if (pop) {
			await repository.popStash(index);
		} else {
			await repository.applyStash(index);
		}
		return serializeRepositoryState(repository);
	}));

	return Disposable.from(...disposables);
}
