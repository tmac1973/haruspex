/**
 * What the Code pane shows of a session and asks of it, whoever runs it: a
 * `CodeSession` here, or a session on another computer seen through its
 * Remote control (plan/instance-sync/). Each type is the local session's,
 * so the two can't drift.
 *
 * `capabilities` says which controls apply. A component hides a control
 * whose capability is off rather than disabling it; a local session has
 * them all.
 */
import type { CodeForkMode } from '#lib/ipc/gen/CodeForkMode.ts';
import type { CodeSession } from '#lib/stores/code.svelte.ts';

type S = CodeSession;

export interface CodeSessionCapabilities {
	/** The branch control, and git state in the transcript. */
	git: boolean;
	/** Settings → Code → Helpers for this session. */
	helpers: boolean;
	/** Specialists for this session. */
	specialists: boolean;
	/** Moving it into a window of its own. */
	detachWindow: boolean;
	/** Opening its folder in a Shell tab here. */
	openInShell: boolean;
	/** Opening its files in this computer's editor. */
	openInEditor: boolean;
	/** Its folder is on this computer: folder pickers, file actions, dropped paths. */
	localFiles: boolean;
}

/** A local session's: everything. */
export const ALL_CAPABILITIES: Readonly<CodeSessionCapabilities> = Object.freeze({
	git: true,
	helpers: true,
	specialists: true,
	detachWindow: true,
	openInShell: true,
	openInEditor: true,
	localFiles: true
});

export interface CodeSessionView {
	readonly capabilities: CodeSessionCapabilities;

	readonly id: S['id'];
	readonly title: S['title'];
	readonly root: S['root'];
	readonly wslDistro: S['wslDistro'];
	readonly status: S['status'];
	readonly busy: S['busy'];
	readonly readOnly: S['readOnly'];
	readonly projectRoot: S['projectRoot'];
	readonly messages: S['messages'];
	readonly messageSteps: S['messageSteps'];
	readonly messageStats: S['messageStats'];
	readonly messageStops: S['messageStops'];
	readonly searchSteps: S['searchSteps'];
	readonly streamingContent: S['streamingContent'];
	readonly roundText: S['roundText'];
	readonly steering: S['steering'];
	readonly steeringDelivered: S['steeringDelivered'];
	readonly returnedSteering: S['returnedSteering'];
	readonly returnedImages: S['returnedImages'];
	readonly prefill: S['prefill'];
	readonly pendingToolCalls: S['pendingToolCalls'];
	readonly lastError: S['lastError'];
	readonly saveError: S['saveError'];
	readonly folderMissing: S['folderMissing'];
	readonly compaction: S['compaction'];
	readonly compacting: S['compacting'];
	readonly contextNotice: S['contextNotice'];
	readonly usage: S['usage'];
	readonly totals: S['totals'];
	readonly background: S['background'];
	readonly shellWait: S['shellWait'];
	readonly effort: S['effort'];
	readonly backend: S['backend'];
	readonly fileNotes: S['fileNotes'];
	readonly ticket: S['ticket'];

	send: S['send'];
	stop: S['stop'];
	continueTurn: S['continueTurn'];
	compactNow: S['compactNow'];
	cancelShellWait: S['cancelShellWait'];
	stopSubtask: S['stopSubtask'];
	setEffort: S['setEffort'];
	setBackend: S['setBackend'];
	takePrefill: S['takePrefill'];
	takeReturnedSteering: S['takeReturnedSteering'];
	takeReturnedImages: S['takeReturnedImages'];
	setDraftReader: S['setDraftReader'];
	refreshBackground: S['refreshBackground'];
	checkFolder: S['checkFolder'];
	/** Take back a steering message that hasn't been delivered yet. */
	removeSteering: S['removeSteering'];

	// Only some capabilities need these.
	readonly git?: S['git'];
	refreshGit?: S['refreshGit'];
	readonly helpers?: S['helpers'];
	readonly specialists?: S['specialists'];
	setSessionHelpers?: S['setSessionHelpers'];
	setSessionSpecialists?: S['setSessionSpecialists'];
	readonly agentsMd?: S['agentsMd'];
	/** Stop reading the project's AGENTS.md (the owner untrusted it). */
	ignoreProject?: S['ignoreProject'];
	moveTo?: S['moveTo'];
	goToShell?: S['goToShell'];
	/** Fork from message `index`, opening the fork; a local session's is `forkFromMessage`. */
	fork?: (index: number, mode: CodeForkMode) => Promise<void>;
	/** `/new`: a new session in the same folder, opened beside this one. */
	newBeside?: () => Promise<void>;
	/** Close its tab here. A local session closes through `closeSession`. */
	close?: () => Promise<void>;
}
