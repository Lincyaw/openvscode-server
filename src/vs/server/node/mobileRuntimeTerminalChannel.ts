/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable local/code-import-patterns */

import { Event, Emitter } from 'vs/base/common/event.js';
import { IServerChannel } from 'vs/base/parts/ipc/common/ipc.js';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration.js';
import { ILogService } from 'vs/platform/log/common/log.js';
import { IProductService } from 'vs/platform/product/common/productService.js';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment.js';
import { IProcessDataEvent, IPtyHostService, ITerminalLaunchError, ITerminalProcessOptions, ProcessPropertyType, TitleEventSource } from 'vs/platform/terminal/common/terminal.js';
import { createTerminalEnvironment } from 'vs/workbench/contrib/terminal/common/terminalEnvironment.js';

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

function basename(path: string): string {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
	const slashIndex = normalized.lastIndexOf('/');
	return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

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
