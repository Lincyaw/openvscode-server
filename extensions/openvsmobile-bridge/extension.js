// VSCode entrypoint shim. The runtime bridge logic lives in main.js so that
// it can be syntax-checked with `node -c main.js` and unit-poked without
// pulling the vscode module.
'use strict';

const vscode = require('vscode');
const bridge = require('./main');

function activate(context) {
	return bridge.activate(context, vscode);
}

function deactivate() {
	return bridge.deactivate();
}

module.exports = { activate, deactivate };
