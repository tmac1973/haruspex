/**
 * Camera alert emails: turn judgements into emails to the addresses in
 * Settings → Cameras → Alerts.
 *
 * - The first Urgent event on a camera emails at once and opens a 10-minute
 *   window. Urgent events in the window are held, and go in one follow-up
 *   when it closes, threaded under the first.
 * - When no model can judge the cameras, one "paused" email; when one judges
 *   again, one "resumed". Which was sent last is kept across restarts.
 *
 * Every recipient and the sending account come from settings at send time,
 * never from an event: a caption, reason or transcript can't change who an
 * email goes to (`camera_alert_send` checks the addresses again).
 */
import { invoke } from '@tauri-apps/api/core';
import type { CameraAlert } from '#lib/ipc/gen/CameraAlert.ts';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
import type { EmailAccount } from '#lib/ipc/gen/EmailAccount.ts';
import { getCameraAlerts, getSettings } from '#lib/stores/settings.ts';
import { stamp } from '#lib/camera/log.ts';
import { onCannotJudge, onJudged } from '#lib/camera/alertEvents.ts';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';
import { sleep } from '#lib/utils/async.ts';

/** How long after an urgent email further ones on that camera are held for one follow-up. */
export const FOLLOW_UP_WINDOW_MS = 10 * 60_000;
/** The wait before one retry of a failed send. */
export const RETRY_MS = 60_000;
const PAUSED_KEY = 'haruspex.cameraAlerts.paused';

/** Why an alert can't be sent right now; null when it can. */
export type SendBlock = 'off' | 'no-address' | 'no-account';

/** The account alerts go from, and where to; or why not. */
export function alertRoute(): { account: EmailAccount; to: string[] } | { blocked: SendBlock } {
	const alerts = getCameraAlerts();
	if (!alerts.enabled) return { blocked: 'off' };
	if (alerts.to.length === 0) return { blocked: 'no-address' };
	const account = getSettings().integrations.email.accounts.find(
		(a) => a.id === alerts.accountId && a.enabled && a.sendEnabled
	);
	if (!account) return { blocked: 'no-account' };
	return { account, to: [...alerts.to] };
}

/** What each block says, naming where to fix it. */
export const BLOCK_TEXT: Record<SendBlock, string> = {
	off: 'alerts are off (Settings → Cameras → Alerts)',
	'no-address': 'no address to send to (Settings → Cameras → Alerts)',
	'no-account': "the account can't send (Settings → Integrations → Email)"
};

/** Send one alert; its Message-ID. Throws with the block's text when it can't go. */
export async function sendAlert(alert: CameraAlert): Promise<string> {
	const route = alertRoute();
	if ('blocked' in route) throw new Error(`Email not sent: ${BLOCK_TEXT[route.blocked]}`);
	return invoke<string>('camera_alert_send', { account: route.account, to: route.to, alert });
}

/** Send, and once more a minute later if that fails; null when it never went. */
async function sendWithRetry(alert: CameraAlert): Promise<string | null> {
	const route = alertRoute();
	if ('blocked' in route) {
		logDebug('camera', 'alert email not sent', { kind: alert.kind, why: route.blocked });
		return null;
	}
	for (let attempt = 0; ; attempt++) {
		try {
			return await sendAlert(alert);
		} catch (e) {
			if (attempt >= 1) {
				console.warn('Camera alert email failed:', errMessage(e));
				return null;
			}
			logDebug('camera', 'alert email failed; retrying', {
				kind: alert.kind,
				error: errMessage(e)
			});
			await sleep(RETRY_MS);
		}
	}
}

/** One event as a body line: time, then what happened and why it was flagged. */
export function eventLine(event: CameraEvent): string {
	const what = event.caption?.trim() || 'No caption.';
	const why = event.alertReason.trim();
	const said = event.transcript.trim();
	return [
		`${stamp(new Date(event.startedAt))} — ${what}`,
		why ? `Why: ${why}` : '',
		said ? `Heard: "${said}"` : ''
	]
		.filter(Boolean)
		.join('\n');
}

interface Window {
	/** The first alert's Message-ID, for the follow-up to thread under. */
	threadId: string | null;
	held: CameraEvent[];
	timer: ReturnType<typeof setTimeout>;
}

const windows = new Map<string, Window>();

/** Email an Urgent event now, or hold it for its camera's follow-up. */
export async function handleUrgent(event: CameraEvent, camera: CameraConfig): Promise<void> {
	const open = windows.get(camera.id);
	if (open) {
		open.held.push(event);
		return;
	}
	const win: Window = {
		threadId: null,
		held: [],
		timer: setTimeout(() => void closeWindow(camera), FOLLOW_UP_WINDOW_MS)
	};
	windows.set(camera.id, win);
	win.threadId = await sendWithRetry({
		kind: 'urgent',
		cameraName: camera.name,
		lines: [`Urgent on ${camera.name}.`, '', eventLine(event)],
		eventIds: [event.id]
	});
}

async function closeWindow(camera: CameraConfig): Promise<void> {
	const win = windows.get(camera.id);
	windows.delete(camera.id);
	if (!win || win.held.length === 0) return;
	await sendWithRetry({
		kind: 'follow_up',
		cameraName: camera.name,
		lines: [
			`${win.held.length} more urgent ${win.held.length === 1 ? 'entry' : 'entries'} on ${camera.name}:`,
			'',
			...win.held.flatMap((e) => [eventLine(e), ''])
		],
		eventIds: win.held.map((e) => e.id),
		...(win.threadId ? { threadId: win.threadId } : {})
	});
}

function pausedSent(): boolean {
	try {
		return localStorage.getItem(PAUSED_KEY) === '1';
	} catch {
		return false;
	}
}

function setPausedSent(on: boolean): void {
	try {
		if (on) localStorage.setItem(PAUSED_KEY, '1');
		else localStorage.removeItem(PAUSED_KEY);
	} catch {
		// Only means a restart may send it again.
	}
}

/** In flight, so a burst of "can't judge" sends one email. */
let pausing = false;

/** No model can judge the cameras: say so once. */
export async function handleCannotJudge(): Promise<void> {
	if (pausing || pausedSent()) return;
	pausing = true;
	try {
		const id = await sendWithRetry({
			kind: 'paused',
			lines: [
				"Camera alerts are paused: no model that may see the cameras is available, or it isn't answering.",
				'Entries are kept and judged once one is back.'
			],
			eventIds: []
		});
		if (id) setPausedSent(true);
	} finally {
		pausing = false;
	}
}

/** A model judged an event: if a pause was sent, say they've resumed. */
async function handleResumed(): Promise<void> {
	if (!pausedSent()) return;
	setPausedSent(false);
	await sendWithRetry({
		kind: 'resumed',
		lines: ['Camera alerts have resumed: entries are being judged again.'],
		eventIds: []
	});
}

/** Called with each judged event. */
export async function handleJudged(event: CameraEvent, camera: CameraConfig): Promise<void> {
	await handleResumed();
	if (event.alertLevel === 'urgent') await handleUrgent(event, camera);
}

let stops: (() => void)[] = [];

/** Start emailing alerts as events are judged. Idempotent. */
export function startAlertDispatch(): void {
	if (stops.length) return;
	stops = [onJudged(handleJudged), onCannotJudge(() => handleCannotJudge())];
}

/** For tests: stop, and forget windows and the pause. */
export function _resetAlertDispatchForTests(): void {
	for (const stop of stops) stop();
	stops = [];
	for (const w of windows.values()) clearTimeout(w.timer);
	windows.clear();
	pausing = false;
	setPausedSent(false);
}
