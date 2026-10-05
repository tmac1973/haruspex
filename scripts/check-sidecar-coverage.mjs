#!/usr/bin/env node
// Every bundle.externalBin entry must be produced by the release workflow.
//
// tauri-build validates each externalBin path at compile time, so an entry
// nothing fetches is not a missing feature — it fails the whole build with
// "resource path ... doesn't exist". That is invisible in CI, which stubs every
// sidecar (scripts/ci-placeholder-sidecars.sh), and the release build matrix
// only runs when release-please cuts a tag. So the gap surfaces for the first
// time during a release, after the tag exists.
//
// This happened: `binaries/sd-server` was added to externalBin in #252, months
// after the previous release, and v0.2.3's build died on it across all three
// platforms. The fetch script existed the whole time — release.yml simply never
// called it. So existence is the wrong test; reachability from the workflow is
// the right one.

import { readFileSync } from 'node:fs';

const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const stems = conf.bundle.externalBin.map((p) => p.split('/').pop());

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

// The closure the release build can actually reach: the workflow's own text
// (it fetches ruff inline) plus every script it invokes.
const invoked = [...workflow.matchAll(/\.\/scripts\/([\w-]+\.sh)/g)].map((m) => m[1]);
let haystack = workflow;
const seen = new Set();
for (const name of invoked) {
	if (seen.has(name)) continue;
	seen.add(name);
	try {
		haystack += readFileSync(`scripts/${name}`, 'utf8');
	} catch {
		console.error(`check-sidecar-coverage: release.yml invokes scripts/${name}, which is missing`);
		process.exit(1);
	}
}

const orphans = stems.filter((stem) => !haystack.includes(stem));
if (orphans.length > 0) {
	for (const stem of orphans) {
		console.error(
			`check-sidecar-coverage: externalBin "${stem}" is never produced by the release build.\n` +
				`  Nothing in .github/workflows/release.yml, nor any script it invokes ` +
				`(${[...seen].join(', ')}), writes that name.\n` +
				`  tauri-build will fail the release with: resource path \`binaries/${stem}-<triple>\` doesn't exist.`
		);
	}
	process.exit(1);
}

console.log(
	`check-sidecar-coverage: OK — all ${stems.length} externalBin sidecars are produced by the release build`
);
