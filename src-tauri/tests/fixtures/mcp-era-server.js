#!/usr/bin/env node
// Dual-era MCP fixture for the client's negotiation tests.
//
// Unlike mcp-echo-server.js (which speaks no protocol at all and exists for
// the process supervisor), this one speaks just enough MCP to exercise every
// branch of the connection sequence. Each mode is one branch:
//
//   modern            server/discover succeeds on 2026-07-28; tools list and call
//   legacy            server/discover fails -32601; initialize handshake works
//   legacy-32602      same, but the probe is refused with -32602 instead
//   legacy-silent     the probe is never answered; only initialize is
//   version-mismatch  discover returns UnsupportedProtocolVersion once, naming a
//                     version it does support, then succeeds on the retry
//   version-dead-end  discover always returns UnsupportedProtocolVersion naming
//                     a version we do not support
//   mrtr              tools/call returns input_required, then completes once the
//                     matching inputResponses come back
//   legacy-elicit     legacy era, and tools/call provokes a server-initiated
//                     elicitation/create
//
// Usage: node mcp-era-server.js <mode>

const mode = process.argv[2] || 'modern';

// A valid `requestedSchema`: rmcp (like the spec) requires `properties`, so a
// bare `{ type: 'object' }` is rejected before it ever reaches our code.
const ELICIT_PARAMS = {
	message: 'Which project?',
	requestedSchema: {
		type: 'object',
		properties: { project: { type: 'string', title: 'Project' } },
		required: ['project']
	}
};

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

const TOOLS = [
	{
		name: 'read_thing',
		description: 'Read a thing. Harmless.',
		inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
		annotations: { readOnlyHint: true, idempotentHint: true }
	},
	{
		// Deliberately annotation-free: the client must carry the absence
		// through rather than inventing a permissive default.
		name: 'unannotated_thing',
		description: 'No annotations at all.',
		inputSchema: { type: 'object' }
	}
];

let handshakeDone = false;
let sawInputResponses = false;
// legacy-elicit: the tools/call we are holding open while we wait for the
// client to answer our elicitation.
let pendingCallId = null;

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
	send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
	const error = { code, message };
	if (data !== undefined) error.data = data;
	send({ jsonrpc: '2.0', id, error });
}

function discoverResult(versions) {
	return {
		resultType: 'complete',
		supportedVersions: versions,
		capabilities: { tools: { listChanged: false } },
		ttlMs: 0,
		cacheScope: 'private',
		_meta: {
			'io.modelcontextprotocol/serverInfo': { name: `fixture-${mode}`, version: '1.0.0' }
		}
	};
}

function toolsResult() {
	return { resultType: 'complete', tools: TOOLS, ttlMs: 0, cacheScope: 'private' };
}

function textResult(text) {
	return { resultType: 'complete', content: [{ type: 'text', text }], isError: false };
}

let versionMismatchesLeft = mode === 'version-mismatch' ? 1 : 0;

function onDiscover(id) {
	switch (mode) {
		case 'legacy':
			return fail(id, -32601, 'Method not found');
		case 'legacy-32602':
			// The spec is explicit that the fallback must not key on one code.
			return fail(id, -32602, 'Invalid params');
		case 'legacy-silent':
		case 'legacy-elicit':
			return; // never answered
		case 'version-dead-end':
			return fail(id, -32022, 'Unsupported protocol version', {
				supported: ['1999-01-01'],
				requested: MODERN
			});
		case 'version-mismatch':
			if (versionMismatchesLeft > 0) {
				versionMismatchesLeft -= 1;
				return fail(id, -32022, 'Unsupported protocol version', {
					supported: [LEGACY, MODERN],
					requested: MODERN
				});
			}
			return reply(id, discoverResult([MODERN]));
		default:
			return reply(id, discoverResult([MODERN]));
	}
}

function onCallTool(id, params) {
	if (mode === 'legacy-elicit') {
		// A legacy server asks by sending its own request, not by returning a
		// result. It then holds the tool call open until the client answers.
		pendingCallId = id;
		send({
			jsonrpc: '2.0',
			id: 'server-1',
			method: 'elicitation/create',
			params: ELICIT_PARAMS
		});
		return;
	}
	if (mode === 'mrtr') {
		if (!sawInputResponses) {
			return reply(id, {
				resultType: 'input_required',
				inputRequests: {
					q1: { method: 'elicitation/create', params: ELICIT_PARAMS }
				},
				requestState: 'opaque-state-1'
			});
		}
		return reply(id, textResult(`answered with ${JSON.stringify(params.inputResponses)}`));
	}
	return reply(id, textResult(`called ${params.name}`));
}

function handle(message) {
	const { id, method, params } = message;

	// A response to a request we sent. In legacy-elicit that is the client
	// refusing our elicitation, which a real server would turn into a failed
	// tool call — the alternative is holding the call open forever, and this
	// fixture exists to prove the client does not hang either way.
	if (method === undefined && id === 'server-1') {
		if (pendingCallId !== null) {
			fail(pendingCallId, -32603, `elicitation refused: ${JSON.stringify(message.error)}`);
			pendingCallId = null;
		}
		return;
	}
	if (id === undefined) return; // a notification; nothing here needs one

	switch (method) {
		case 'server/discover':
			return onDiscover(id);
		case 'initialize':
			handshakeDone = true;
			return reply(id, {
				protocolVersion: LEGACY,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: `fixture-${mode}`, version: '1.0.0' }
			});
		case 'tools/list':
			return reply(id, toolsResult());
		case 'tools/call':
			if (params && params.inputResponses) sawInputResponses = true;
			return onCallTool(id, params || {});
		case 'ping':
			return reply(id, {});
		default:
			return fail(id, -32601, `Method not found: ${method}`);
	}
}

process.stderr.write(`fixture: ${mode} ready\n`);
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf('\n')) !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		try {
			handle(JSON.parse(line));
		} catch (e) {
			process.stderr.write(`fixture: bad line: ${e}\n`);
		}
	}
});
process.stdin.on('end', () => process.exit(0));

// Referenced so the handshake flag is observable in stderr when debugging a
// failing test; the client never reads it.
process.on('exit', () => {
	process.stderr.write(`fixture: exiting (handshake=${handshakeDone})\n`);
});
