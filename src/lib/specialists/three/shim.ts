/**
 * The script injected into a 3D specialist's HTML before it runs in the
 * off-screen artifact iframe (see `runHtml.ts`). It reports every error to
 * the parent, turns the page's GLB download into a message, keeps WebGL
 * canvases readable, and answers the parent's `hx-snapshot` and `hx-export`.
 *
 * It is written over several lines here and joined into one: injected on the
 * same line as the `<head>` tag, it moves no line of the original file, so
 * the line numbers the browser reports are the ones the model wrote. No `//`
 * comments and no string literal may span a line break.
 */
const SHIM_SOURCE = `(function () {
	var send = function (m, transfer) { parent.postMessage(m, '*', transfer || []); };
	var err = function (kind, message, line, col) {
		send({ t: 'hx-err', kind: kind, message: String(message), line: line || null, col: col || null });
	};
	var describe = function (v) {
		if (v instanceof Error) return v.message || String(v);
		if (typeof v === 'string') return v;
		try { return JSON.stringify(v); } catch (e) { return String(v); }
	};
	window.addEventListener('error', function (e) {
		if (e instanceof ErrorEvent) { err('error', e.message, e.lineno, e.colno); return; }
		var t = e.target;
		if (t && t !== window && (t.src || t.href)) err('error', 'Failed to load ' + (t.src || t.href), null, null);
	}, true);
	window.addEventListener('unhandledrejection', function (e) { err('rejection', describe(e.reason), null, null); });
	var origError = console.error;
	console.error = function () {
		err('console', Array.prototype.map.call(arguments, describe).join(' ').slice(0, 300), null, null);
		return origError.apply(console, arguments);
	};
	var blobs = new Map();
	var origCreate = URL.createObjectURL;
	URL.createObjectURL = function (obj) {
		var url = origCreate.call(URL, obj);
		if (obj instanceof Blob) blobs.set(url, obj);
		return url;
	};
	var dataBytes = function (href) {
		var comma = href.indexOf(',');
		var meta = href.slice(5, comma);
		var body = href.slice(comma + 1);
		if (!/;base64$/i.test(meta)) return new TextEncoder().encode(decodeURIComponent(body)).buffer;
		var bin = atob(body);
		var out = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out.buffer;
	};
	var grab = function (a) {
		if (!a.hasAttribute('download')) return false;
		var href = a.href;
		var blob = blobs.get(href);
		if (blob) {
			blob.arrayBuffer().then(function (buf) { send({ t: 'hx-glb', bytes: buf }, [buf]); },
				function (e) { err('error', 'Could not read the download: ' + describe(e), null, null); });
			return true;
		}
		if (/^data:/i.test(href)) {
			var buf = dataBytes(href);
			send({ t: 'hx-glb', bytes: buf }, [buf]);
			return true;
		}
		return false;
	};
	var origClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () { if (!grab(this)) origClick.call(this); };
	var origDispatch = HTMLAnchorElement.prototype.dispatchEvent;
	HTMLAnchorElement.prototype.dispatchEvent = function (ev) {
		if (ev && ev.type === 'click' && grab(this)) return false;
		return origDispatch.call(this, ev);
	};
	var origGetContext = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, attrs) {
		if (/^(webgl2?|experimental-webgl)$/.test(type)) attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
		return origGetContext.call(this, type, attrs);
	};
	var snapshot = function () {
		var best = null;
		var bestArea = -1;
		document.querySelectorAll('canvas').forEach(function (c) {
			var r = c.getBoundingClientRect();
			var area = r.width * r.height > 0 ? r.width * r.height : 0;
			if (area > bestArea) { best = c; bestArea = area; }
		});
		if (!best) return null;
		try { return best.toDataURL('image/png'); } catch (e) { err('error', 'Could not read the canvas: ' + describe(e), null, null); return null; }
	};
	var exportButton = function () {
		var all = document.querySelectorAll('button, a, [role=button]');
		for (var i = 0; i < all.length; i++) {
			var el = all[i];
			if (/export|glb|download/i.test((el.textContent || '') + ' ' + (el.getAttribute('title') || ''))) return el;
		}
		return null;
	};
	window.addEventListener('message', function (e) {
		if (e.source !== parent || !e.data) return;
		if (e.data.t === 'hx-snapshot') send({ t: 'hx-png', dataUrl: snapshot() });
		if (e.data.t === 'hx-export') {
			var b = exportButton();
			if (b) b.click();
			else send({ t: 'hx-err', kind: 'no-export', message: 'No Export GLB button found.', line: null, col: null });
		}
	});
	window.addEventListener('load', function () { send({ t: 'hx-ready' }); });
})();`;

/** The shim as one line of JavaScript. */
export const SHIM = SHIM_SOURCE.replace(/\n\s*/g, ' ');

/**
 * Put the shim in `html` straight after the first `<head>` tag, else after
 * the first `<html>` tag, else at the very start.
 */
export function injectShim(html: string): string {
	const tag = `<script>${SHIM}</script>`;
	const at = /<head(?:\s[^>]*)?>/i.exec(html) ?? /<html(?:\s[^>]*)?>/i.exec(html);
	if (!at) return tag + html;
	const end = at.index + at[0].length;
	return html.slice(0, end) + tag + html.slice(end);
}
