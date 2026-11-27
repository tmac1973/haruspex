/**
 * run_command's watch for a password or passphrase prompt (`sudo`, `ssh`).
 * While the command waits at one, its time limit stops: the Shell tab asks
 * the user to type it in the terminal (`setSecretWait`), and notifies them
 * the first time if Haruspex isn't in front. Any new output clears it. After
 * `SECRET_WAIT_MAX_MS` at one prompt, run_command gives up and says why.
 */

import { invoke } from '@tauri-apps/api/core';
import { notify } from '#lib/notify.ts';
import { secretPrompt } from '#lib/shell/secretPrompt.ts';
import { setSecretWait } from '#lib/stores/shellPtyBusy.svelte.ts';

/** How many polls the output must stay still before it's read for a prompt. */
const QUIET_POLLS = 3;

/** The longest run_command waits for the user to type a password. */
export const SECRET_WAIT_MAX_MS = 10 * 60 * 1000;

export interface SecretClock {
	/**
	 * Called each poll with the terminal's output watermark: the deadline to
	 * keep to, pushed out while a prompt waits, or 0 once the wait is too long.
	 */
	poll(outputTotal: number, deadline: number): Promise<number>;
	/** The run stopped because the password never came. */
	readonly gaveUp: boolean;
}

export function secretClock(
	sessionId: number,
	fromOutput: number,
	timeoutSecs: number
): SecretClock {
	const watch = promptWatch(sessionId, fromOutput);
	let since: number | null = null;
	let gaveUp = false;
	return {
		async poll(outputTotal, deadline) {
			if (!(await watch(outputTotal))) {
				since = null;
				return deadline;
			}
			since ??= Date.now();
			if (Date.now() - since >= SECRET_WAIT_MAX_MS) {
				gaveUp = true;
				return 0;
			}
			return Math.max(deadline, Date.now() + timeoutSecs * 1000);
		},
		get gaveUp() {
			return gaveUp;
		}
	};
}

/** Whether the command is waiting at a prompt now, read once its output goes still. */
function promptWatch(
	sessionId: number,
	fromOutput: number
): (outputTotal: number) => Promise<boolean> {
	let seen = fromOutput;
	let still = 0;
	let checkedAt = -1;
	let waiting = false;
	let notified = false;
	const clear = () => {
		if (!waiting) return;
		waiting = false;
		setSecretWait(sessionId, null);
	};
	return async (outputTotal) => {
		if (outputTotal !== seen) {
			seen = outputTotal;
			still = 0;
			clear();
			return false;
		}
		if (waiting) return true;
		still += 1;
		if (still < QUIET_POLLS || seen === fromOutput || checkedAt === seen) return false;
		checkedAt = seen;
		const prompt = await readPrompt(sessionId, fromOutput);
		if (!prompt) return false;
		waiting = true;
		setSecretWait(sessionId, prompt);
		if (!notified && typeof document !== 'undefined' && !document.hasFocus()) {
			notified = true;
			void notify('Haruspex is waiting for your password', prompt);
		}
		return true;
	};
}

async function readPrompt(sessionId: number, from: number): Promise<string | null> {
	try {
		return secretPrompt(await invoke<string>('shell_output_since', { sessionId, from }));
	} catch {
		return null;
	}
}
