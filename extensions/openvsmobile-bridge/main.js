const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const infoPath = process.env.OPENVSCODE_MOBILE_GIT_RUNTIME_INFO_PATH
  || path.join(os.homedir(), '.config', 'openvscode-mobile', 'git-runtime.json');

let runtimeServer;
let runtimeToken;
let logChannel;
let disposables = [];

function activate(context) {
  runtimeToken = crypto.randomBytes(24).toString('hex');
  logChannel = vscode.window.createOutputChannel('OpenVS Mobile Bridge');
  context.subscriptions.push(logChannel);
  context.subscriptions.push({ dispose: deactivate });
  startGitRuntimeBridge().catch((error) => {
    log(`failed to start git runtime bridge: ${formatError(error)}`);
  });
}

async function startGitRuntimeBridge() {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    log('vscode.git extension is unavailable; Git runtime bridge stays disabled');
    return;
  }

  await gitExtension.activate();
  const git = gitExtension.exports.getAPI(1);
  runtimeServer = http.createServer((request, response) => {
    handleRequest(git, request, response).catch((error) => {
      writeJson(response, 500, { error: formatError(error) });
    });
  });

  await new Promise((resolve, reject) => {
    runtimeServer.once('error', reject);
    runtimeServer.listen(0, '127.0.0.1', () => {
      runtimeServer.off('error', reject);
      resolve();
    });
  });

  fs.mkdirSync(path.dirname(infoPath), { recursive: true });
  fs.writeFileSync(infoPath, JSON.stringify({
    port: runtimeServer.address().port,
    token: runtimeToken,
    updatedAt: new Date().toISOString(),
    pid: process.pid,
  }, null, 2));

  log(`git runtime bridge listening on 127.0.0.1:${runtimeServer.address().port}`);
}

async function handleRequest(git, request, response) {
  if (!isAuthorized(request)) {
    writeJson(response, 401, { error: 'unauthorized' });
    return;
  }

  const parsed = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && parsed.pathname === '/events') {
    const repoPath = parsed.searchParams.get('path') || '';
    if (!repoPath) {
      writeJson(response, 400, { error: 'path is required' });
      return;
    }
    await handleEventsRequest(git, repoPath, request, response);
    return;
  }

  const body = request.method === 'POST' ? await readJsonBody(request) : {};
  const repoPath = typeof body.path === 'string' ? body.path : '';

  switch (`${request.method} ${parsed.pathname}`) {
    case 'POST /repository':
      writeJson(response, 200, await serializeRepository(await ensureRepository(git, repoPath)));
      return;
    case 'POST /stage':
      await ensureFiles(body.files);
      {
        const repo = await ensureRepository(git, repoPath);
        await repo.add(asStringArray(body.files));
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    case 'POST /unstage':
      await ensureFiles(body.files);
      {
        const repo = await ensureRepository(git, repoPath);
        await repo.revert(toUris(repoPath, asStringArray(body.files)));
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    case 'POST /commit':
      {
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) {
          writeJson(response, 400, { error: 'message is required' });
          return;
        }
        const repo = await ensureRepository(git, repoPath);
        await repo.commit(message, { postCommitCommand: null });
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    case 'POST /checkout':
      {
        const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
        if (!ref) {
          writeJson(response, 400, { error: 'ref is required' });
          return;
        }
        const repo = await ensureRepository(git, repoPath);
        if (body.create === true) {
          await repo.createBranch(ref, true);
        } else {
          await repo.checkout(ref);
        }
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    case 'POST /fetch':
      {
        const repo = await ensureRepository(git, repoPath);
        const remote = typeof body.remote === 'string' && body.remote ? body.remote : undefined;
        await repo.fetch(remote ? { remote } : undefined);
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    case 'POST /pull':
      {
        const repo = await ensureRepository(git, repoPath);
        await repo.pull(false);
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    case 'POST /push':
      {
        const repo = await ensureRepository(git, repoPath);
        const remote = typeof body.remote === 'string' && body.remote ? body.remote : undefined;
        const branch = typeof body.branch === 'string' && body.branch ? body.branch : undefined;
        await repo.push(remote, branch, body.setUpstream === true);
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    case 'POST /discard':
      await ensureFiles(body.files);
      {
        const repo = await ensureRepository(git, repoPath);
        await repo.clean(toUris(repoPath, asStringArray(body.files)));
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    case 'POST /diff':
      {
        const file = typeof body.file === 'string' ? body.file : '';
        if (!file) {
          writeJson(response, 400, { error: 'file is required' });
          return;
        }
        const repo = await ensureRepository(git, repoPath);
        const diff = body.staged === true
          ? await repo.diffIndexWithHEAD(file)
          : await repo.diffWithHEAD(file);
        writeJson(response, 200, { path: file, diff, staged: body.staged === true });
      }
      return;
    case 'POST /stash':
      {
        const repo = await ensureRepository(git, repoPath);
        const options = {};
        if (typeof body.message === 'string' && body.message.trim()) {
          options.message = body.message.trim();
        }
        if (body.includeUntracked === true) {
          options.includeUntracked = true;
        }
        await repo.createStash(options);
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    case 'POST /stash/apply':
      {
        const repo = await ensureRepository(git, repoPath);
        const stashIndex = parseStashIndex(body.stash);
        if (body.pop === true) {
          await repo.popStash(stashIndex);
        } else {
          await repo.applyStash(stashIndex);
        }
        writeJson(response, 200, await serializeRepository(repo));
      }
      return;
    default:
      writeJson(response, 404, { error: 'not found' });
  }
}

async function handleEventsRequest(git, repoPath, request, response) {
  const repo = await ensureRepository(git, repoPath);
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const writeRepository = async () => {
    response.write(`${JSON.stringify(await serializeRepository(repo))}\n`);
  };

  await writeRepository();
  let pending = Promise.resolve();
  const disposable = repo.state.onDidChange(() => {
    pending = pending
      .then(() => writeRepository())
      .catch((error) => log(`repositoryChanged push failed: ${formatError(error)}`));
  });
  const close = () => {
    disposable.dispose();
    try {
      response.end();
    } catch {
      // Ignore close races.
    }
  };
  request.on('close', close);
  request.on('aborted', close);
}

async function ensureRepository(git, repoPath) {
  if (!repoPath) {
    throw new Error('path is required');
  }
  const uri = vscode.Uri.file(repoPath);
  const existing = git.getRepository(uri);
  if (existing) {
    return existing;
  }
  const opened = await git.openRepository(uri);
  if (opened) {
    return opened;
  }
  throw new Error(`repository not found for ${repoPath}`);
}

async function serializeRepository(repo) {
  const rootPath = repo.rootUri.fsPath;
  const remoteBranches = await repo.getBranches({ remote: true }).catch(() => []);
  const branchesByRemote = new Map();
  for (const branch of remoteBranches) {
    if (!branch.remote || !branch.name) {
      continue;
    }
    const current = branchesByRemote.get(branch.remote) || [];
    current.push(branch.name);
    branchesByRemote.set(branch.remote, current);
  }

  const conflicts = [];
  const mergeChanges = [];
  for (const change of repo.state.mergeChanges) {
    const mapped = mapChange(rootPath, change);
    if (mapped.status === 'both_added' || mapped.status === 'both_deleted' || mapped.status === 'both_modified') {
      conflicts.push(mapped);
    } else {
      mergeChanges.push(mapped);
    }
  }

  const head = repo.state.HEAD;
  return {
    path: rootPath,
    branch: head && head.name ? head.name : '',
    upstream: head && head.upstream ? `${head.upstream.remote}/${head.upstream.name}` : '',
    ahead: head && typeof head.ahead === 'number' ? head.ahead : 0,
    behind: head && typeof head.behind === 'number' ? head.behind : 0,
    remotes: repo.state.remotes.map((remote) => ({
      name: remote.name,
      fetchUrl: remote.fetchUrl || '',
      pushUrl: remote.pushUrl || '',
      isReadOnly: remote.isReadOnly === true,
      branches: (branchesByRemote.get(remote.name) || []).sort(),
    })),
    staged: repo.state.indexChanges.map((change) => mapChange(rootPath, change)),
    unstaged: repo.state.workingTreeChanges.map((change) => mapChange(rootPath, change)),
    untracked: repo.state.untrackedChanges.map((change) => mapChange(rootPath, change)),
    conflicts,
    mergeChanges,
  };
}

function mapChange(rootPath, change) {
  const currentUri = change.renameUri || change.uri;
  const originalUri = change.originalUri || change.uri;
  const current = normalizeRelative(rootPath, currentUri.fsPath);
  const original = normalizeRelative(rootPath, originalUri.fsPath);
  const mapping = mapStatus(change.status);
  const result = {
    path: current,
    status: mapping.status,
    indexStatus: mapping.indexStatus,
    workingTreeStatus: mapping.workingTreeStatus,
  };
  if (original && original !== current) {
    result.originalPath = original;
  }
  if (mapping.mergeStatus) {
    result.mergeStatus = mapping.mergeStatus;
  }
  return result;
}

function mapStatus(status) {
  switch (status) {
    case 0: return { status: 'modified', indexStatus: 'M', workingTreeStatus: '' };
    case 1: return { status: 'added', indexStatus: 'A', workingTreeStatus: '' };
    case 2: return { status: 'deleted', indexStatus: 'D', workingTreeStatus: '' };
    case 3: return { status: 'renamed', indexStatus: 'R', workingTreeStatus: '' };
    case 4: return { status: 'copied', indexStatus: 'C', workingTreeStatus: '' };
    case 5: return { status: 'modified', indexStatus: '', workingTreeStatus: 'M' };
    case 6: return { status: 'deleted', indexStatus: '', workingTreeStatus: 'D' };
    case 7: return { status: 'untracked', indexStatus: '?', workingTreeStatus: '?' };
    case 8: return { status: 'ignored', indexStatus: '', workingTreeStatus: '' };
    case 9: return { status: 'intent_to_add', indexStatus: '', workingTreeStatus: 'A' };
    case 10: return { status: 'intent_to_rename', indexStatus: '', workingTreeStatus: 'R' };
    case 11: return { status: 'type_changed', indexStatus: '', workingTreeStatus: 'T' };
    case 12: return mergeStatus('added_by_us', 'A', 'U');
    case 13: return mergeStatus('added_by_them', 'U', 'A');
    case 14: return mergeStatus('deleted_by_us', 'D', 'U');
    case 15: return mergeStatus('deleted_by_them', 'U', 'D');
    case 16: return mergeStatus('both_added', 'A', 'A');
    case 17: return mergeStatus('both_deleted', 'D', 'D');
    case 18: return mergeStatus('both_modified', 'U', 'U');
    default: return { status: 'unknown', indexStatus: '', workingTreeStatus: '' };
  }
}

function mergeStatus(kind, current, incoming) {
  return {
    status: kind,
    indexStatus: current,
    workingTreeStatus: incoming,
    mergeStatus: { kind, current, incoming },
  };
}

function normalizeRelative(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath);
  return relative.split(path.sep).join('/');
}

function toUris(rootPath, files) {
  return files.map((file) => vscode.Uri.file(path.join(rootPath, file)));
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

async function ensureFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('at least one file is required');
  }
}

function parseStashIndex(stashRef) {
  if (typeof stashRef !== 'string' || !stashRef) {
    return undefined;
  }
  const match = stashRef.match(/^stash@\{(\d+)\}$/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

async function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => body += chunk);
    request.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function isAuthorized(request) {
  const header = request.headers.authorization || '';
  return header === `Bearer ${runtimeToken}`;
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function log(message) {
  if (logChannel) {
    logChannel.appendLine(`[openvsmobile-bridge] ${message}`);
  }
}

function deactivate() {
  for (const disposable of disposables) {
    try {
      disposable.dispose();
    } catch {
      // Ignore disposal races.
    }
  }
  disposables = [];

  if (runtimeServer) {
    runtimeServer.close();
    runtimeServer = undefined;
  }
  try {
    fs.rmSync(infoPath, { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

module.exports = {
  activate,
  deactivate,
};
