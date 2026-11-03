/**
 * Run a model-written build module in the hidden sandboxed frame and get its
 * GLB. The module imports nothing: its default export (or `build`) is called
 * as `build(THREE, kit)` with the bundled kit (`kitEntry.ts`) and returns an
 * `Object3D` or `{ object, animations }`; the page exports that with
 * `GLTFExporter`. An animation module beside it (`anim`) gets the built
 * object as `animate(THREE, object, kit)` and returns more clips: a module
 * can't import a sibling file, since each runs from its own `blob:` URL.
 * PNGs the modules name with `kit.texture` come in as data URLs (`textures`),
 * decoded into textures before either module runs.
 * Errors carry their line in the model's own file, and which file that is.
 */
import { threeKitUrl } from '#lib/helpers/three/kitUrl.ts';
import { runHiddenFrame, type FrameControl } from '#lib/sandbox/hiddenFrame.ts';
import { LATE_MS, type RunError } from '#lib/specialists/three/runHtml.ts';

/** A run's error, with the module it came from: the build module or the animation module. */
export interface ModuleError extends RunError {
	file: 'build' | 'anim';
}

export interface ModuleRunResult {
	glb: Uint8Array | null;
	errors: ModuleError[];
	/** Animation tracks naming a node the object doesn't have; the exporter drops them. */
	missingTracks: string[];
}

export interface ModuleRunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** An animation module's source: its `animate(THREE, object, kit)` adds clips. */
	anim?: string;
	/** The PNGs the modules use, as data URLs keyed by the path `kit.texture` is called with. */
	textures?: Record<string, string>;
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
	var srcUrl, animUrl;
	var fileOf = function (text) { return animUrl && String(text).indexOf(animUrl) >= 0 ? 'anim' : 'build'; };
	var where = function (stack) {
		var lines = String(stack || '').split('\\n');
		for (var i = 0; i < lines.length; i++) { var m = pattern.exec(lines[i]); if (m) return { line: Number(m[1]), file: fileOf(lines[i]) }; }
		return { line: null, file: 'build' };
	};
	var err = function (message, at) { send({ t: 'hx-err', kind: 'error', message: String(message).replace(/^Uncaught /, ''), line: at.line, file: at.file }); };
	var own = function (message, file) { var e = new Error(message); e.hxOwn = file || 'build'; return e; };
	var started = false;
	var end = function () { send({ t: 'hx-end' }); };
	window.addEventListener('error', function (e) {
		var fromModule = /^blob:/.test(e.filename || '');
		err(e.message, fromModule ? { line: e.lineno, file: fileOf(e.filename) } : where(e.error && e.error.stack));
	});
	window.addEventListener('unhandledrejection', function (e) {
		var r = e.reason;
		err(r && r.message ? r.message : String(r), where(r && r.stack));
	});
	var kit = window.HaruspexThreeKit;
	if (!kit) { err('The 3D kit did not load.', { line: null, file: 'build' }); end(); return; }
	var animate = async function (anim, object) {
		var fn = typeof anim.default === 'function' ? anim.default : anim.animate;
		if (typeof fn !== 'function') throw own('The animation module has no default export function animate(THREE, object, kit).', 'anim');
		var extra = await fn(kit.THREE, object, kit.kit);
		var clips = Array.isArray(extra) && extra.every(function (c) { return c && (c.isAnimationClip || Array.isArray(c.tracks)); });
		if (!clips) throw own('animate() must return an array of AnimationClip.', 'anim');
		return extra;
	};
	window.__hxRun = async function (mod, anim) {
		started = true;
		try {
			var build = typeof mod.default === 'function' ? mod.default : mod.build;
			if (typeof build !== 'function') throw own('The module has no default export function build(THREE, kit).');
			var out = await build(kit.THREE, kit.kit);
			var object = out && out.isObject3D ? out : out && out.object;
			var animations = out && out.isObject3D ? [] : (out && out.animations) || [];
			if (!object || !object.isObject3D) throw own('build() must return an Object3D or { object, animations }.');
			if (anim) {
				var extra = await animate(anim, object);
				extra.forEach(function (c) { if (animations.some(function (b) { return b.name === c.name; })) throw own('Clip "' + c.name + '" comes from both modules.', 'anim'); });
				animations = animations.concat(extra);
			}
			var PB = kit.THREE.PropertyBinding; var missing = [];
			animations.forEach(function (clip) { (clip.tracks || []).forEach(function (t) { if (!PB.findNode(object, PB.parseTrackName(t.name).nodeName) && missing.indexOf(t.name) < 0) missing.push(t.name); }); });
			if (missing.length) send({ t: 'hx-missing', tracks: missing });
			var glb = await new kit.GLTFExporter().parseAsync(object, { binary: true, animations: animations });
			send({ t: 'hx-glb', bytes: glb }, [glb]);
		} catch (e) {
			err(e && e.message ? e.message : String(e), e && e.hxOwn ? { line: null, file: e.hxOwn } : where(e && e.stack));
			end();
		}
	};
	var blob = function (code) { return URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); };
	srcUrl = blob(window.__hxSource);
	animUrl = typeof window.__hxAnim === 'string' ? blob(window.__hxAnim) : null;
	var load = function () {
		var s = document.createElement('script');
		s.type = 'module';
		s.src = blob(animUrl
			? 'import * as mod from "' + srcUrl + '"; import * as anim from "' + animUrl + '"; window.__hxRun(mod, anim);'
			: 'import * as mod from "' + srcUrl + '"; window.__hxRun(mod);');
		var after = function () { if (!started) end(); };
		s.addEventListener('load', after);
		s.addEventListener('error', function () { err('The module did not load.', { line: null, file: 'build' }); after(); });
		document.head.appendChild(s);
	};
	var decode = async function (path, url) {
		var T = kit.THREE;
		var bitmap = await createImageBitmap(await (await fetch(url)).blob());
		var canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext('2d').drawImage(bitmap, 0, 0);
		var t = new T.CanvasTexture(canvas);
		t.name = path;
		t.colorSpace = T.SRGBColorSpace;
		t.wrapS = t.wrapT = T.RepeatWrapping;
		return t;
	};
	var textures = window.__hxTextures || {};
	var paths = Object.keys(textures);
	if (!paths.length) { load(); return; }
	(async function () {
		var made = {};
		for (var i = 0; i < paths.length; i++) {
			try { made[paths[i]] = await decode(paths[i], textures[paths[i]]); }
			catch (e) { err('Texture ' + paths[i] + ' could not be decoded.', { line: null, file: 'build' }); end(); return; }
		}
		kit.setTextures(made);
		load();
	})();
})();`.replace(/\n\s*/g, ' ');

/** `value` as JSON that can sit in a script tag: `<` escaped so it can't end the tag. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The page that runs `source` (and `animSource`), with the kit loaded from the
 * app's origin and `textures` (path → PNG data URL) for `kit.texture`.
 */
export function modulePage(
	source: string,
	kitUrl = threeKitUrl(),
	animSource?: string,
	textures: Record<string, string> = {}
): string {
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		`<script src="${kitUrl}"></script>`,
		`<script>window.__hxSource = ${scriptJson(source)};</script>`,
		`<script>window.__hxAnim = ${scriptJson(animSource ?? null)};</script>`,
		`<script>window.__hxTextures = ${scriptJson(textures)};</script>`,
		`<script>${RUNNER}</script>`,
		'</head><body></body></html>'
	].join('\n');
}

/** Run a build module; resolves with its GLB, or with the errors that stopped it. */
export async function runBuildModule(
	source: string,
	opts: ModuleRunOptions = {}
): Promise<ModuleRunResult> {
	const { signal, timeoutMs = 45_000, anim, textures } = opts;
	const result: ModuleRunResult = { glb: null, errors: [], missingTracks: [] };
	const settle = (ctl: FrameControl) => {
		ctl.clearDeadline();
		ctl.later(LATE_MS, () => ctl.done());
	};
	await runHiddenFrame(modulePage(source, threeKitUrl(), anim, textures), {
		signal,
		timeoutMs,
		onTimeout: (ctl) => {
			result.errors.push({
				kind: 'timeout',
				message: `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for build() to return.`,
				line: null,
				file: 'build'
			});
			ctl.done();
		},
		onMessage: (data, ctl) => {
			if (data.t === 'hx-err') {
				const line = typeof data.line === 'number' && data.line > 0 ? data.line : null;
				const file = data.file === 'anim' ? 'anim' : 'build';
				result.errors.push({ kind: 'error', message: String(data.message ?? ''), line, file });
			} else if (data.t === 'hx-missing' && Array.isArray(data.tracks)) {
				result.missingTracks = data.tracks.map(String);
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
