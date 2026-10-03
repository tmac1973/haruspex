#!/usr/bin/env node
/**
 * Hand-synced constants drift guard.
 *
 * The sidecar ports and loopback host exist on both sides of the IPC
 * boundary with no codegen: `src/lib/ports.ts` (TS) must match the
 * `ports` module + `LOOPBACK` const in `src-tauri/src/sidecar_utils.rs`
 * (Rust). This script parses both and fails on any mismatch, so a port
 * change that touches only one side breaks CI instead of a user.
 *
 * Deliberately NOT covered: context-size defaults — server/mod.rs
 * documents that the user-facing default lives in TS and the Rust side
 * requires the parameter, so there is nothing to drift.
 *
 * Usage:  node scripts/check-constants.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function extract(source, regex, label, file) {
	const m = source.match(regex);
	if (!m) {
		console.error(`check-constants: could not find ${label} in ${file}`);
		process.exit(1);
	}
	return m[1];
}

const sdcpp = readFileSync(join(root, 'scripts/fetch-sdcpp.sh'), 'utf8');
const sdcppDoc = readFileSync(join(root, 'docs/image-generation.md'), 'utf8');

const ts = readFileSync(join(root, 'src/lib/ports.ts'), 'utf8');
const rs = readFileSync(join(root, 'src-tauri/src/sidecar_utils.rs'), 'utf8');

const pairs = [
	{
		name: 'llama port',
		ts: extract(ts, /llama:\s*(\d+)/, 'PORTS.llama', 'ports.ts'),
		rs: extract(rs, /const LLAMA: u16 = (\d+);/, 'ports::LLAMA', 'sidecar_utils.rs')
	},
	{
		name: 'whisper port',
		ts: extract(ts, /whisper:\s*(\d+)/, 'PORTS.whisper', 'ports.ts'),
		rs: extract(rs, /const WHISPER: u16 = (\d+);/, 'ports::WHISPER', 'sidecar_utils.rs')
	},
	{
		name: 'tts port',
		ts: extract(ts, /tts:\s*(\d+)/, 'PORTS.tts', 'ports.ts'),
		rs: extract(rs, /const TTS: u16 = (\d+);/, 'ports::TTS', 'sidecar_utils.rs')
	},
	{
		// An unpinned sidecar is a reproducibility hole, and a pin recorded in
		// two places is a pin that drifts. The doc is what a human reads; the
		// script is what actually fetches.
		name: 'sd-server version',
		tsFile: 'scripts/fetch-sdcpp.sh',
		rsFile: 'docs/image-generation.md',
		ts: extract(sdcpp, /SDCPP_VERSION="([^"]+)"/, 'SDCPP_VERSION', 'fetch-sdcpp.sh'),
		rs: extract(sdcppDoc, /\| Pinned version \| `([^`]+)` \|/, 'the pinned version row', 'image-generation.md')
	},
	{
		name: 'loopback host',
		ts: extract(ts, /LOOPBACK = '([^']+)'/, 'LOOPBACK', 'ports.ts'),
		rs: extract(rs, /const LOOPBACK: &str = "([^"]+)";/, 'LOOPBACK', 'sidecar_utils.rs')
	}
];

const drifted = pairs.filter((p) => p.ts !== p.rs);
if (drifted.length > 0) {
	for (const p of drifted) {
		// Named per pair: most of these are the TS/Rust port constants, but
		// not all, and a message pointing at the wrong file costs more time
		// than the drift it reports.
		console.error(
			`check-constants: ${p.name} drifted — ${p.tsFile ?? 'src/lib/ports.ts'} has ${p.ts}, ` +
				`${p.rsFile ?? 'src-tauri/src/sidecar_utils.rs'} has ${p.rs}`
		);
	}
	process.exit(1);
}

console.log(`check-constants: OK — ${pairs.length} hand-synced constants match`);
