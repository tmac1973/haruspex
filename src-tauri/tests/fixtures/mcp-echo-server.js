#!/usr/bin/env node
// Stdio fixture for the MCP process supervisor's tests.
//
// Not an MCP server — it speaks no protocol. It exists so the supervisor's
// lifecycle behaviour (spawn, crash, hang, stop, orphan reaping) can be proven
// before Phase 03 has anything to negotiate with. Run through the bundled Node
// from Phase 01.
//
// Usage: node mcp-echo-server.js <mode>
//
//   normal            announce on stderr, echo each stdin line to stdout, run
//                     until stdin closes
//   exit-immediately  announce on stderr, then exit(1) without reading anything
//   hang              announce nothing, read nothing, never exit
//   noisy             write many stderr lines, then behave like `normal`

const mode = process.argv[2] || 'normal';

if (mode === 'exit-immediately') {
	process.stderr.write('fixture: exiting immediately\n');
	process.exit(1);
}

if (mode === 'hang') {
	// No output, no stdin handling, no exit. The pipes stay open, so from the
	// outside this is indistinguishable from a healthy server that is simply
	// not being asked anything — which is the point of the test.
	setInterval(() => {}, 1 << 30);
} else {
	if (mode === 'noisy') {
		for (let i = 0; i < 50; i++) {
			process.stderr.write(`fixture: line ${i}\n`);
		}
	}
	process.stderr.write('fixture: ready\n');
	process.stdin.setEncoding('utf8');
	let buffer = '';
	process.stdin.on('data', (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			process.stdout.write(`${line}\n`);
		}
	});
	process.stdin.on('end', () => process.exit(0));
}
