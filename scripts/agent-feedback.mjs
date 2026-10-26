#!/usr/bin/env node
/**
 * Summarise the model's reports on Haruspex's tools (Settings → Feedback →
 * Model feedback on tools; see docs/guide/model-feedback.md).
 *
 * Reads every `*.jsonl` in the app's `agent_feedback` folder, or the folder or
 * file given, then prints counts by tool and kind and the latest reports with
 * the calls behind them.
 *
 *   node scripts/agent-feedback.mjs [path] [--all] [--last N] [--tool NAME]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const IDENTIFIER = 'com.haruspex.app';

function defaultDir() {
	const home = homedir();
	const base =
		platform() === 'darwin'
			? join(home, 'Library', 'Application Support')
			: platform() === 'win32'
				? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
				: (process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'));
	return join(base, IDENTIFIER, 'agent_feedback');
}

function files(path) {
	if (!existsSync(path)) return [];
	if (!statSync(path).isDirectory()) return [path];
	return readdirSync(path)
		.filter((f) => f.endsWith('.jsonl'))
		.sort()
		.map((f) => join(path, f));
}

function readReports(paths) {
	const reports = [];
	for (const file of paths) {
		for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
			if (!line.trim()) continue;
			try {
				reports.push(JSON.parse(line));
			} catch {
				console.warn(`${file}:${i + 1}: not JSON, skipped`);
			}
		}
	}
	return reports;
}

function countBy(reports, key) {
	const counts = new Map();
	for (const r of reports) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function printReport(r) {
	console.log(`\n── ${r.recorded_at ?? '?'}  ${r.tool} · ${r.kind} · ${r.origin} · ${r.mode}`);
	console.log(`   ${r.model} · v${r.app_version ?? '?'}${r.source ? ` · ${r.source}` : ''}`);
	console.log(`   What happened: ${r.what_happened}`);
	console.log(`   Expected:      ${r.expected}`);
	if (r.suggestion) console.log(`   Suggestion:    ${r.suggestion}`);
	for (const c of r.trace ?? []) {
		console.log(`     · ${c.tool}${c.error ? ' (failed)' : ''} ${c.args}`);
		console.log(`       → ${c.result.replace(/\s+/g, ' ').slice(0, 300)}`);
	}
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		all: { type: 'boolean', default: false },
		last: { type: 'string', default: '10' },
		tool: { type: 'string' }
	}
});

const source = positionals[0] ?? defaultDir();
let reports = readReports(files(source));
if (values.tool) reports = reports.filter((r) => r.tool === values.tool);
if (reports.length === 0) {
	console.log(`No reports in ${source}.`);
	process.exit(0);
}

console.log(`${reports.length} reports from ${source}\n`);
console.log('By tool:');
for (const [tool, n] of countBy(reports, (r) => r.tool))
	console.log(`  ${String(n).padStart(4)}  ${tool}`);
console.log('\nBy kind:');
for (const [kind, n] of countBy(reports, (r) => r.kind))
	console.log(`  ${String(n).padStart(4)}  ${kind}`);
console.log('\nBy model:');
for (const [model, n] of countBy(reports, (r) => r.model))
	console.log(`  ${String(n).padStart(4)}  ${model}`);

const shown = values.all ? reports : reports.slice(-Number(values.last));
for (const r of shown) printReport(r);
