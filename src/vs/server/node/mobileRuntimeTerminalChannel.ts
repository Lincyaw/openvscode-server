/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Buffer } from 'buffer';
import { basename } from 'path';
import { Event, Emitter } from '../../base/common/event.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { IServerChannel } from '../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IPtyService, IProcessDataEvent, ProcessPropertyType, TitleEventSource } from '../../platform/terminal/common/terminal.js';
import { RemoteAgentConnectionContext } from '../../platform/remote/common/remoteAgentEnvironment.js';

const maxBacklogBytes = 64 * 1024;

interface TerminalSessionDocument {
	id: string;
	name: string;
	cwd: string;
	profile: string;
	state: 'running' | 'exited';
	exitCode?: number;
	rows?: number;
	cols?: number;
	shellIntegration?: {
		enabled: boolean;
		commandDetection: boolean;
	};
}

interface TerminalAttachDocument {
	session: TerminalSessionDocument;
	backlog?: string;
}

interface TerminalLifecycleEvent {
	type: 'created' | 'updated' | 'closed';
	session: TerminalSessionDocument;
}

interface TerminalStreamEvent {
	type: 'output' | 'exit' | 'closed';
	data?: string;
	session?: TerminalSessionDocument;
}

interface RuntimeTerminalSession {
	processId: number;
	id: string;
	name: string;
	cwd: string;
	profile: string;
	state: 'running' | 'exited';
	exitCode?: number;
	rows: number;
	cols: number;
	backlog: Buffer;
	shellIntegrationEnabled: boolean;
}

function normalizeProfile(profile: string | undefined, executable: string): string {
	const requested = (profile ?? '').trim();
	if (requested.length > 0) {
		return requested;
	}
	const base = basename(executable).toLowerCase();
	if (base.includes('zsh')) {
		return 'zsh';
	}
	if (base.includes('fish')) {
		return 'fish';
	}
	if (base.includes('powershell') || base.includes('pwsh')) {
		return 'pwsh';
	}
	if (base.includes('cmd')) {
		return 'cmd';
	}
	return 'bash';
}

function defaultExecutable(): string {
	if (process.platform === 'win32') {
		return process.env.ComSpec || 'cmd.exe';
	}
	return process.env.SHELL || '/bin/bash';
}

function encodeChunk(data: string): string {
	return Buffer.from(data, 'utf8').toString('base64');
}

function decodeData(event: IProcessDataEvent | string): string {
	return typeof event === 'string' ? event : event.data;
}

export class MobileTerminalChannel implements IServerChannel<RemoteAgentConnectionContext> {
	private readonly disposables = new DisposableStore();
	private readonly sessions = new Map<number, RuntimeTerminalSession>();
	private readonly sessionById = new Map<string, RuntimeTerminalSession>();
	private readonly streamEmitters = new Map<string, Emitter<TerminalStreamEvent>>();
	private readonly lifecycleEmitter = new Emitter<TerminalLifecycleEvent>();

	constructor(
		private readonly logService: ILogService,
		private readonly ptyService: IPtyService
	) {
		this.disposables.add(this.lifecycleEmitter);
		this.disposables.add(this.ptyService.onProcessData(({ id, event }) => {
			const session = this.sessions.get(id);
			if (!session) {
				return;
			}
			const data = decodeData(event);
			if (data.length === 0) {
				return;
			}
			this.appendBacklog(session, data);
			this.stream(session.id).fire({ type: 'output', data: encodeChunk(data) });
			if (typeof event !== 'string' && event.trackCommit) {
				void this.ptyService.acknowledgeDataEvent(id, data.length);
			}
		}));
		this.disposables.add(this.ptyService.onDidChangeProperty(({ id, property }) => {
			const session = this.sessions.get(id);
			if (!session) {
				return;
			}
			switch (property.type) {
				case ProcessPropertyType.Cwd:
					if (typeof property.value === 'string' && property.value.length > 0) {
						session.cwd = property.value;
						this.fireLifecycle('updated', session);
					}
					break;
				case ProcessPropertyType.Title:
					if (typeof property.value === 'string' && property.value.trim().length > 0) {
						session.name = property.value;
						this.fireLifecycle('updated', session);
					}
					break;
				case ProcessPropertyType.UsedShellIntegrationInjection:
					session.shellIntegrationEnabled = property.value === true;
					this.fireLifecycle('updated', session);
					break;
			}
		}));
		this.disposables.add(this.ptyService.onProcessReady(({ id, event }) => {
			const session = this.sessions.get(id);
			if (!session) {
				return;
			}
			if (event.cwd) {
				session.cwd = event.cwd;
			}
			this.fireLifecycle('updated', session);
		}));
		this.disposables.add(this.ptyService.onProcessExit(({ id, event }) => {
			const session = this.sessions.get(id);
			if (!session) {
				return;
			}
			session.state = 'exited';
			if (typeof event === 'number') {
				session.exitCode = event;
			}
			const snapshot = this.snapshot(session);
			this.stream(session.id).fire({ type: 'exit', session: snapshot });
			this.fireLifecycle('updated', session);
		}));
	}

	call(_ctx: RemoteAgentConnectionContext, command: string, arg?: any): Promise<any> {
		this.logService.trace(`[MobileTerminalChannel] ${command}`, arg);
		switch (command) {
			case 'list': return this.list();
			case 'create': return this.create(arg);
			case 'attach': return this.attach(arg);
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
				return this.lifecycleEmitter.event;
			case 'stream':
				if (typeof arg?.id !== 'string' || arg.id.length === 0) {
					throw new Error('terminal session id is required');
				}
				this.requireSession(arg.id);
				return this.stream(arg.id).event;
		}
		throw new Error(`Event not found: ${event}`);
	}

	private async list(): Promise<TerminalSessionDocument[]> {
		return Array.from(this.sessionById.values()).map(session => this.snapshot(session));
	}

	private async create(arg: any): Promise<TerminalSessionDocument> {
		const cwd = typeof arg?.cwd === 'string' && arg.cwd.length > 0 ? arg.cwd : '/';
		const rows = typeof arg?.rows === 'number' && arg.rows > 0 ? arg.rows : 24;
		const cols = typeof arg?.cols === 'number' && arg.cols > 0 ? arg.cols : 80;
		const executable = defaultExecutable();
		const profile = normalizeProfile(typeof arg?.profile === 'string' ? arg.profile : undefined, executable);
		const env = await this.ptyService.getEnvironment();
		const processId = await this.ptyService.createProcess({
			name: typeof arg?.name === 'string' && arg.name.length > 0 ? arg.name : undefined,
			executable,
			cwd,
			args: [],
			useShellEnvironment: true,
		}, cwd, cols, rows, '11', env, env, {
			shellIntegration: {
				enabled: false,
				suggestEnabled: false,
				nonce: '',
			},
			windowsUseConptyDll: false,
			environmentVariableCollections: undefined,
			workspaceFolder: undefined,
			isScreenReaderOptimized: false,
		}, true, 'openvsmobile', 'OpenVS Mobile');
		const session: RuntimeTerminalSession = {
			processId,
			id: `term-${processId}`,
			name: typeof arg?.name === 'string' && arg.name.length > 0 ? arg.name : `term-${processId}`,
			cwd,
			profile,
			state: 'running',
			rows,
			cols,
			backlog: Buffer.alloc(0),
			shellIntegrationEnabled: false,
		};
		this.sessions.set(processId, session);
		this.sessionById.set(session.id, session);
		await this.ptyService.start(processId);
		void this.refreshSessionProperties(processId, session);
		this.fireLifecycle('created', session);
		return this.snapshot(session);
	}

	private async attach(arg: any): Promise<TerminalAttachDocument> {
		const session = this.requireSession(typeof arg?.id === 'string' ? arg.id : '');
		try {
			await this.ptyService.attachToProcess(session.processId);
		} catch {
			// Already attached or unsupported; the runtime state is still authoritative.
		}
		return {
			session: this.snapshot(session),
			backlog: session.backlog.length > 0 ? session.backlog.toString('base64') : undefined,
		};
	}

	private async input(arg: any): Promise<TerminalSessionDocument> {
		const session = this.requireSession(typeof arg?.id === 'string' ? arg.id : '');
		const data = typeof arg?.data === 'string' ? arg.data : '';
		if (data.length === 0) {
			throw new Error('terminal input data is required');
		}
		await this.ptyService.input(session.processId, data);
		return this.snapshot(session);
	}

	private async resize(arg: any): Promise<TerminalSessionDocument> {
		const session = this.requireSession(typeof arg?.id === 'string' ? arg.id : '');
		const rows = typeof arg?.rows === 'number' && arg.rows > 0 ? arg.rows : session.rows;
		const cols = typeof arg?.cols === 'number' && arg.cols > 0 ? arg.cols : session.cols;
		await this.ptyService.resize(session.processId, cols, rows);
		session.rows = rows;
		session.cols = cols;
		this.fireLifecycle('updated', session);
		return this.snapshot(session);
	}

	private async rename(arg: any): Promise<TerminalSessionDocument> {
		const session = this.requireSession(typeof arg?.id === 'string' ? arg.id : '');
		const name = typeof arg?.name === 'string' ? arg.name.trim() : '';
		if (name.length === 0) {
			throw new Error('terminal name is required');
		}
		session.name = name;
		await this.ptyService.updateTitle(session.processId, name, TitleEventSource.Api);
		this.fireLifecycle('updated', session);
		return this.snapshot(session);
	}

	private async split(arg: any): Promise<TerminalSessionDocument> {
		const parent = this.requireSession(typeof arg?.parentId === 'string' ? arg.parentId : '');
		return this.create({
			cwd: parent.cwd,
			profile: parent.profile,
			name: typeof arg?.name === 'string' && arg.name.trim().length > 0 ? arg.name.trim() : `${parent.name} split`,
			rows: parent.rows,
			cols: parent.cols,
		});
	}

	private async close(arg: any): Promise<TerminalSessionDocument> {
		const session = this.requireSession(typeof arg?.id === 'string' ? arg.id : '');
		session.state = 'exited';
		await this.ptyService.shutdown(session.processId, true);
		const snapshot = this.snapshot(session);
		this.sessions.delete(session.processId);
		this.sessionById.delete(session.id);
		this.stream(session.id).fire({ type: 'closed', session: snapshot });
		this.fireLifecycle('closed', session);
		return snapshot;
	}

	private requireSession(id: string): RuntimeTerminalSession {
		const session = this.sessionById.get(id);
		if (!session) {
			throw new Error(`terminal session not found: ${id}`);
		}
		return session;
	}

	private snapshot(session: RuntimeTerminalSession): TerminalSessionDocument {
		return {
			id: session.id,
			name: session.name,
			cwd: session.cwd,
			profile: session.profile,
			state: session.state,
			exitCode: session.exitCode,
			rows: session.rows,
			cols: session.cols,
			shellIntegration: {
				enabled: session.shellIntegrationEnabled,
				commandDetection: false,
			},
		};
	}

	private stream(id: string): Emitter<TerminalStreamEvent> {
		let emitter = this.streamEmitters.get(id);
		if (!emitter) {
			emitter = new Emitter<TerminalStreamEvent>();
			this.streamEmitters.set(id, emitter);
		}
		return emitter;
	}

	private fireLifecycle(type: TerminalLifecycleEvent['type'], session: RuntimeTerminalSession): void {
		this.lifecycleEmitter.fire({ type, session: this.snapshot(session) });
	}

	private appendBacklog(session: RuntimeTerminalSession, data: string): void {
		const chunk = Buffer.from(data, 'utf8');
		const next = Buffer.concat([session.backlog, chunk]);
		if (next.length > maxBacklogBytes) {
			session.backlog = next.subarray(next.length - maxBacklogBytes);
			return;
		}
		session.backlog = next;
	}

	private async refreshSessionProperties(processId: number, session: RuntimeTerminalSession): Promise<void> {
		try {
			const cwd = await this.ptyService.refreshProperty(processId, ProcessPropertyType.Cwd);
			if (typeof cwd === 'string' && cwd.length > 0) {
				session.cwd = cwd;
			}
		} catch {
			// Ignore best-effort refresh failures.
		}
		try {
			const shellIntegration = await this.ptyService.refreshProperty(processId, ProcessPropertyType.UsedShellIntegrationInjection);
			session.shellIntegrationEnabled = shellIntegration === true;
		} catch {
			// Ignore best-effort refresh failures.
		}
		this.fireLifecycle('updated', session);
	}
}
