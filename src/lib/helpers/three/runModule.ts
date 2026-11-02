/**
 * Run a model-written build module in the hidden sandboxed frame and get its
 * GLB. The module imports nothing: its default export (or `build`) is called
 * as `build(THREE, kit)` with the bundled kit (`kitEntry.ts`) and returns an
 * `Object3D` or `{ object, animations }`; the page exports that with
 * `GLTFExporter`. Errors carry their line in the model's own file.
 */
import { threeKitUrl } from '#lib/helpers/three/kitUrl.ts';
import { runHiddenFrame, type FrameControl } from '#lib/sandbox/hiddenFrame.ts';
import { LATE_MS, type RunError } from '#lib/specialists/three/runHtml.ts';

export interface ModuleRunResult {
	glb: Uint8Array | null;
	errors: RunError[];
}

export interface ModuleRunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** The first `blob:` frame's line in a stack: WebKit `f@blob:…:12:7`, Chromium `at f (blob:…:12:7)`. */
export const LINE_PATTERN = /blob:\S*?:(\d+):(\d+)\)?\s*$/;

/** The line of the model's file an error's stack points at, or null. */
export function lineOf(stack: string | undefined): number | null {
	for (const l of (stack ?? '').split('\n')) {
		const m = LINE_PATTERN.exec(l);
		if (m) return Number(m[1]);
	}
	return null;
}

/**
 * The page's script. Written over several lines and joined into one, so it
 * may hold no `//` comment and no string literal across a line break.
 */
const RUNNER = `(function () {
	var send = function (m, transfer) { parent.postMessage(m, '*', transfer || []); };
	var pattern = ${LINE_PATTERN.toString()};
	var lineOf = function (stack) {
		var lines = String(stack || '').split('\\n');
		for (var i = 0; i < lines.length; i++) { var m = pattern.exec(lines[i]); if (m) return Number(m[1]); }
		return null;
	};
	var err = function (message, line) { send({ t: 'hx-err', kind: 'error', message: String(message).replace(/^Uncaught /, ''), line: line }); };
	var own = function (message) { var e = new Error(message); e.hxOwn = true; return e; };
	var started = false;
	var end = function () { send({ t: 'hx-end' }); };
	window.addEventListener('error', function (e) {
		var fromModule = /^blob:/.test(e.filename || '');
		err(e.message, fromModule ? e.lineno : lineOf(e.error && e.error.stack));
	});
	window.addEventListener('unhandledrejection', function (e) {
		var r = e.reason;
		err(r && r.message ? r.message : String(r), lineOf(r && r.stack));
	});
	var kit = window.HaruspexThreeKit;
	if (!kit) { err('The 3D kit did not load.', null); end(); return; }
	window.__hxRun = async function (mod) {
		started = true;
		try {
			var build = typeof mod.default === 'function' ? mod.default : mod.build;
			if (typeof build !== 'function') throw own('The module has no default export function build(THREE, kit).');
			var out = await build(kit.THREE, kit.kit);
			var object = out && out.isObject3D ? out : out && out.object;
			var animations = out && out.isObject3D ? [] : (out && out.animations) || [];
			if (!object || !object.isObject3D) throw own('build() must return an Object3D or { object, animations }.');
			var glb = await new kit.GLTFExporter().parseAsync(object, { binary: true, animations: animations });
			send({ t: 'hx-glb', bytes: glb }, [glb]);
		} catch (e) {
			err(e && e.message ? e.message : String(e), e && e.hxOwn ? null : lineOf(e && e.stack));
			end();
		}
	};
	var blob = function (code) { return URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); };
	var source = blob(window.__hxSource);
	var s = document.createElement('script');
	s.type = 'module';
	s.src = blob('import * as mod from "' + source + '"; window.__hxRun(mod);');
	var after = function () { if (!started) end(); };
	s.addEventListener('load', after);
	s.addEventListener('error', function () { err('The module did not load.', null); after(); });
	document.head.appendChild(s);
})();`.replace(/\n\s*/g, ' ');

/** The page that runs `source`, with the kit loaded from the app's origin. */
export function modulePage(source: string, kitUrl = threeKitUrl()): string {
	// `<` escaped so the source can't end the script tag it sits in.
	const json = JSON.stringify(source).replace(/</g, '\\u003c');
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		`<script src="${kitUrl}"></script>`,
		`<script>window.__hxSource = ${json};</script>`,
		`<script>${RUNNER}</script>`,
		'</head><body></body></html>'
	].join('\n');
}

/** Run a build module; resolves with its GLB, or with the errors that stopped it. */
export async function runBuildModule(
	source: string,
	opts: ModuleRunOptions = {}
): Promise<ModuleRunResult> {
	const { signal, timeoutMs = 45_000 } = opts;
	const result: ModuleRunResult = { glb: null, errors: [] };
	const settle = (ctl: FrameControl) => {
		ctl.clearDeadline();
		ctl.later(LATE_MS, () => ctl.done());
	};
	await runHiddenFrame(modulePage(source), {
		signal,
		timeoutMs,
		onTimeout: (ctl) => {
			result.errors.push({
				kind: 'timeout',
				message: `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for build() to return.`,
				line: null
			});
			ctl.done();
		},
		onMessage: (data, ctl) => {
			if (data.t === 'hx-err') {
				const line = typeof data.line === 'number' && data.line > 0 ? data.line : null;
				result.errors.push({ kind: 'error', message: String(data.message ?? ''), line });
			} else if (data.t === 'hx-glb' && data.bytes instanceof ArrayBuffer) {
				result.glb = new Uint8Array(data.bytes);
				settle(ctl);
			} else if (data.t === 'hx-end') {
				settle(ctl);
			}
		}
	});
	return result;
}
