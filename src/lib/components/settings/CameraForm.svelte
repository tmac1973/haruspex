<script lang="ts">
	/**
	 * One camera's form in Settings → Cameras: a network camera by its RTSP
	 * address (typed, or found over ONVIF), or a USB webcam. Edits a draft;
	 * nothing is saved until Save.
	 *
	 * A password typed here goes to the secret store on Save. Test needs it
	 * before then, so it is kept under a separate key for the test
	 * (`camera:<id>:test`) and deleted when the form closes, which leaves the
	 * saved password alone until Save. The aim buttons use the same test camera.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { onDestroy } from 'svelte';
	import { redactCameraError, splitUrlCredentials } from '#lib/camera/credentials.ts';
	import { hostOf, onvifAddressFor, withHost } from '#lib/camera/onvif.ts';
	import type { AimDirection } from '#lib/ipc/gen/AimDirection.ts';
	import type { CameraAimResult } from '#lib/ipc/gen/CameraAimResult.ts';
	import type { CameraCaps } from '#lib/ipc/gen/CameraCaps.ts';
	import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
	import type { CameraListenResult } from '#lib/ipc/gen/CameraListenResult.ts';
	import type { CameraPermission } from '#lib/ipc/gen/CameraPermission.ts';
	import type { MotionSensitivity } from '#lib/ipc/gen/MotionSensitivity.ts';
	import type { DiscoveredCamera } from '#lib/ipc/gen/DiscoveredCamera.ts';
	import type { OnvifConnection } from '#lib/ipc/gen/OnvifConnection.ts';
	import type { OnvifEndpoint } from '#lib/ipc/gen/OnvifEndpoint.ts';
	import type { OnvifPreset } from '#lib/ipc/gen/OnvifPreset.ts';
	import type { PtzKind } from '#lib/ipc/gen/PtzKind.ts';
	import type { UsbDevices } from '#lib/ipc/gen/UsbDevices.ts';
	import { forgetCameraPassword, withStoredCameraPassword } from '#lib/stores/cameraSecrets.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { videoOverrides } from '#lib/video/binaries.ts';

	interface Props {
		/** The camera to edit; a new one carries a fresh id and no name. */
		camera: CameraConfig;
		/** Every other camera's name, for the duplicate check. */
		otherNames: string[];
		/** The camera as it should be stored, its password already in the secret store. */
		onSave: (camera: CameraConfig) => void;
		onCancel: () => void;
	}

	let { camera, otherNames, onSave, onCancel }: Props = $props();

	// The form starts from the camera it was opened with; the parent remounts it per camera.
	// svelte-ignore state_referenced_locally
	const start = camera;
	const startRtsp = start.source.kind === 'rtsp' ? start.source : null;
	const startUsb = start.source.kind === 'usb' ? start.source : null;

	let kind = $state<'rtsp' | 'usb'>(start.source.kind);
	let name = $state(start.name);
	let url = $state(startRtsp?.url ?? '');
	let substreamUrl = $state(startRtsp?.substreamUrl ?? '');
	let username = $state(startRtsp?.username ?? '');
	let password = $state('');
	const passwordSaved = !!startRtsp?.passwordRef;
	let videoDevice = $state(startUsb?.videoDevice ?? '');
	let audioDevice = $state(startUsb?.audioDevice ?? '');
	let permission = $state<CameraPermission>(start.permission);
	let caps = $state<CameraCaps | null>(start.caps);
	let ptz = $state<PtzKind>(start.ptz);
	let onvif = $state<OnvifEndpoint | null>(start.onvif);
	let watchOn = $state(start.watcher.enabled);
	let hoursStart = $state(start.watcher.activeHours?.start ?? '');
	let hoursEnd = $state(start.watcher.activeHours?.end ?? '');
	/** WebKitGTK draws an empty time box as a time, so the boxes show only for "Between". */
	let hoursLimited = $state(!!start.watcher.activeHours);
	let sensitivity = $state<MotionSensitivity>(start.watcher.motionSensitivity);
	let soundDb = $state(start.watcher.soundThresholdDb);

	let found = $state<DiscoveredCamera[] | null>(null);
	let finding = $state(false);
	let picked = $state<DiscoveredCamera | null>(null);
	/** Use the picked camera's network name rather than its address. */
	let useName = $state(true);
	let connecting = $state(false);
	let onvifError = $state('');
	let refreshing = $state(false);

	let devices = $state<UsbDevices | null>(null);
	let devicesError = $state('');
	/** Whether the picked webcam can pan or tilt; null while unknown. */
	let uvcSupported = $state<boolean | null>(null);
	let saving = $state(false);
	let saveError = $state('');

	let testing = $state(false);
	let frame = $state('');
	let level = $state<number | null>(null);
	let testError = $state('');
	let aiming = $state(false);
	/** The key a password typed for Test was kept under, deleted when the form closes. */
	let testKey: string | null = null;

	const nameError = $derived.by(() => {
		const n = name.trim();
		if (!n) return 'Give it a name.';
		const lower = n.toLowerCase();
		return otherNames.some((o) => o.toLowerCase() === lower) ? 'Another camera has this name.' : '';
	});

	const sourceError = $derived.by(() => {
		if (kind === 'usb') return videoDevice ? '' : 'Pick a webcam.';
		return /^rtsps?:\/\/\S+/i.test(url.trim()) ? '' : 'Enter an address starting rtsp://.';
	});

	const hoursError = $derived(
		watchOn && hoursLimited && !(hoursStart && hoursEnd) ? 'Set both times.' : ''
	);

	$effect(() => {
		const device = videoDevice;
		if (kind !== 'usb' || !device) {
			uvcSupported = null;
			return;
		}
		let current = true;
		uvcSupported = null;
		void invoke<boolean>('camera_uvc_supported', { device })
			.then((ok) => {
				if (current) uvcSupported = ok;
			})
			.catch(() => {
				if (current) uvcSupported = false;
			});
		return () => {
			current = false;
		};
	});

	/** The pan/tilt the camera would be saved with. */
	const savedPtz = $derived.by((): PtzKind => {
		if (kind === 'rtsp') return ptz === 'onvif' && onvif ? 'onvif' : 'none';
		return ptz === 'uvc' && uvcSupported !== false ? 'uvc' : 'none';
	});

	/** Move a `user:pass@` written into an address into the fields. */
	function takeCredentials(which: 'url' | 'substream') {
		const split = splitUrlCredentials(which === 'url' ? url : substreamUrl);
		if (which === 'url') url = split.url;
		else substreamUrl = split.url;
		if (split.username !== null) username = split.username;
		if (split.password !== null) password = split.password;
	}

	async function loadDevices() {
		devicesError = '';
		try {
			devices = await invoke<UsbDevices>('camera_usb_devices', { overrides: videoOverrides() });
			if (!videoDevice && devices.video.length) pickVideo(devices.video[0].id);
		} catch (e) {
			devicesError = errMessage(e);
		}
	}

	/** Pick a webcam, and the microphone that seems to be its own. */
	function pickVideo(id: string) {
		videoDevice = id;
		const own = devices?.video.find((v) => v.id === id)?.audioDevice;
		audioDevice = own ?? '';
	}

	function setKind(next: 'rtsp' | 'usb') {
		kind = next;
		frame = '';
		level = null;
		testError = '';
		if (next === 'usb' && !devices) void loadDevices();
	}

	if (start.source.kind === 'usb') void loadDevices();

	/** The form as a camera, with `passwordRef` as given. */
	function draft(passwordRef: string | null): CameraConfig {
		takeCredentials('url');
		if (substreamUrl.trim()) takeCredentials('substream');
		return {
			...start,
			name: name.trim(),
			source:
				kind === 'rtsp'
					? {
							kind: 'rtsp',
							url: url.trim(),
							substreamUrl: substreamUrl.trim() || null,
							username: username.trim(),
							passwordRef
						}
					: { kind: 'usb', videoDevice, audioDevice: audioDevice || null },
			permission,
			watcher: {
				enabled: watchOn,
				activeHours:
					hoursLimited && hoursStart && hoursEnd ? { start: hoursStart, end: hoursEnd } : null,
				motionSensitivity: sensitivity,
				soundThresholdDb: soundDb
			},
			ptz: savedPtz,
			onvif: kind === 'rtsp' ? $state.snapshot(onvif) : null,
			caps
		};
	}

	const savedRef = startRtsp?.passwordRef ?? null;

	/** What a found camera is called in the list. */
	function foundLabel(c: DiscoveredCamera): string {
		let host = c.xaddr;
		try {
			host = new URL(c.xaddr).host;
		} catch {
			// Shown as given.
		}
		const title = c.name || c.hardware;
		const where = c.hostname || host;
		return title ? `${title} · ${where}` : where;
	}

	async function findCameras() {
		finding = true;
		onvifError = '';
		picked = null;
		try {
			found = await invoke<DiscoveredCamera[]>('camera_onvif_discover');
			// Picked at once, so Connect shows without a click; another can be picked.
			if (found.length) pickFound(found[0]);
		} catch (e) {
			onvifError = errMessage(e);
		} finally {
			finding = false;
		}
	}

	function pickFound(c: DiscoveredCamera) {
		picked = c;
		useName = true;
		onvifError = '';
		if (!name.trim() && c.name) name = c.name;
	}

	/**
	 * The ONVIF service to sign in to: the camera picked from Find cameras, or
	 * else the one at the RTSP address's host, for a camera that doesn't answer.
	 */
	const connectTo = $derived(
		picked ? pickedAddress(picked.xaddr) : kind === 'rtsp' ? onvifAddressFor(url) : null
	);

	/** `address` on the picked camera's network name, when it has one and it's wanted. */
	function pickedAddress(address: string): string {
		if (!picked?.hostname || !useName) return address;
		return withHost(address, hostOf(picked.xaddr), picked.hostname);
	}

	/** Sign in over ONVIF and fill in the camera's streams and pan/tilt. */
	async function connectFound() {
		const xaddr = connectTo;
		if (!xaddr) return;
		if (!password && passwordSaved) {
			onvifError = 'Type the password again to connect.';
			return;
		}
		connecting = true;
		onvifError = '';
		const typed = password;
		try {
			const got = await invoke<OnvifConnection>('camera_onvif_connect', {
				xaddr,
				username: username.trim(),
				password
			});
			// The camera gives its streams on its address; keep them on its name.
			url = pickedAddress(got.mainUrl);
			substreamUrl = got.subUrl === got.mainUrl ? '' : pickedAddress(got.subUrl);
			onvif = { xaddr, profileToken: got.profileToken, presets: got.presets };
			ptz = got.hasPtz ? 'onvif' : 'none';
			found = null;
			picked = null;
		} catch (e) {
			onvifError = redactCameraError(errMessage(e), typed);
		} finally {
			connecting = false;
		}
	}

	async function refreshPresets() {
		refreshing = true;
		onvifError = '';
		const typed = password;
		try {
			const config = await testCamera();
			const presets = await invoke<OnvifPreset[]>('camera_onvif_presets', { config });
			if (onvif) onvif = { ...onvif, presets };
		} catch (e) {
			onvifError = redactCameraError(errMessage(e), typed);
		} finally {
			refreshing = false;
		}
	}

	async function forgetTestPassword() {
		if (!testKey) return;
		const key = testKey;
		testKey = null;
		await forgetCameraPassword({
			...start,
			source: { kind: 'rtsp', url: '', substreamUrl: null, username: '', passwordRef: key }
		});
	}

	/** The camera to test, its typed password kept under the test key. */
	async function testCamera(): Promise<CameraConfig> {
		if (kind !== 'rtsp' || !password) return draft(savedRef);
		const kept = await withStoredCameraPassword(
			{ ...draft(null), id: `${start.id}:test` },
			password
		);
		if (kept.source.kind === 'rtsp') testKey = kept.source.passwordRef;
		return { ...kept, id: start.id };
	}

	async function test() {
		testing = true;
		testError = '';
		frame = '';
		level = null;
		const typed = password;
		try {
			const config = await testCamera();
			const overrides = videoOverrides();
			caps = await invoke<CameraCaps>('camera_probe', { config, overrides });
			frame = await invoke<string>('camera_snapshot', { config, overrides });
			if (caps.hasAudio) {
				const heard = await invoke<CameraListenResult>('camera_listen', {
					config,
					seconds: 3,
					transcribe: false,
					overrides
				});
				level = heard.levelDb;
			}
		} catch (e) {
			testError = redactCameraError(errMessage(e), typed);
		} finally {
			testing = false;
		}
	}

	const AIMS: { direction: AimDirection; label: string; title: string }[] = [
		{ direction: 'left', label: 'Left', title: 'Turns the camera about 10° left.' },
		{ direction: 'right', label: 'Right', title: 'Turns the camera about 10° right.' },
		{ direction: 'up', label: 'Up', title: 'Tilts the camera about 10° up.' },
		{ direction: 'down', label: 'Down', title: 'Tilts the camera about 10° down.' },
		{ direction: 'home', label: 'Home', title: 'Points the camera back to its home position.' }
	];

	/** Turn the camera a little and show what it sees now. */
	async function aimTest(direction: AimDirection) {
		aiming = true;
		testError = '';
		const typed = password;
		try {
			const config = await testCamera();
			await invoke<CameraAimResult>('camera_aim', {
				config,
				aim: { direction, amount: 'small' }
			});
			frame = await invoke<string>('camera_snapshot', { config, overrides: videoOverrides() });
		} catch (e) {
			testError = redactCameraError(errMessage(e), typed);
		} finally {
			aiming = false;
		}
	}

	async function save() {
		saving = true;
		saveError = '';
		try {
			let next = draft(kind === 'rtsp' ? savedRef : null);
			if (kind === 'rtsp' && password) next = await withStoredCameraPassword(next, password);
			// A camera that was on the network and is now USB drops its password.
			if (kind === 'usb' && savedRef) void forgetCameraPassword(start);
			await forgetTestPassword();
			onSave(next);
		} catch (e) {
			saveError = `Couldn't save the password: ${redactCameraError(errMessage(e), password)}`;
		} finally {
			saving = false;
		}
	}

	function cancel() {
		void forgetTestPassword();
		onCancel();
	}

	onDestroy(() => void forgetTestPassword());

	function levelText(db: number): string {
		return db <= -120 ? 'Silent' : `${Math.round(db)} dB`;
	}

	/** A bar from -60 dB (empty) to 0 dB (full). */
	function levelPercent(db: number): number {
		return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
	}
</script>

<div class="form">
	<span class="label">Kind</span>
	<div class="segmented" role="group" aria-label="Kind">
		<button type="button" class:active={kind === 'rtsp'} onclick={() => setKind('rtsp')}
			>Network</button
		>
		<button type="button" class:active={kind === 'usb'} onclick={() => setKind('usb')}>USB</button>
	</div>

	<label for="cam-name-{start.id}">Name</label>
	<div>
		<input
			id="cam-name-{start.id}"
			bind:value={name}
			placeholder="Kitchen"
			title="What you and the assistant call it."
		/>
		{#if nameError}<p class="error">{nameError}</p>{/if}
	</div>

	{#if kind === 'rtsp'}
		<span class="label">Find</span>
		<div>
			<button
				type="button"
				class="btn btn-small"
				onclick={findCameras}
				disabled={finding}
				title="Looks for ONVIF cameras on the local network for 3 seconds. You can also type the address below."
			>
				{finding ? 'Looking…' : 'Find cameras'}
			</button>
			{#if found && found.length === 0}
				<p class="help">No ONVIF cameras answered.</p>
			{/if}
			{#if found && found.length}
				<ul class="found" aria-label="Cameras found">
					{#each found as c (c.xaddr)}
						<li>
							<button
								type="button"
								class:active={picked?.xaddr === c.xaddr}
								onclick={() => pickFound(c)}>{foundLabel(c)}</button
							>
						</li>
					{/each}
				</ul>
			{/if}
			{#if picked?.hostname}
				<label
					class="toggle-row"
					title="Its address can change when the router hands out a new one; the name follows it."
				>
					<input type="checkbox" bind:checked={useName} />
					<span>Use its name, {picked.hostname}, not {hostOf(picked.xaddr)}</span>
				</label>
			{/if}
			{#if picked}
				<p class="help">Enter its user name and password below, then connect.</p>
			{/if}
			{#if connectTo}
				<button
					type="button"
					class="btn btn-small"
					onclick={connectFound}
					disabled={connecting}
					title={picked
						? 'Signs in over ONVIF and fills in the stream addresses and pan/tilt.'
						: 'Signs in over ONVIF at the RTSP address, for a camera Find cameras missed, and fills in pan/tilt.'}
				>
					{connecting ? 'Connecting…' : 'Connect'}
				</button>
			{/if}
			{#if onvifError}<p class="error">{onvifError}</p>{/if}
		</div>

		<label for="cam-url-{start.id}">RTSP address</label>
		<div>
			<input
				id="cam-url-{start.id}"
				bind:value={url}
				onchange={() => takeCredentials('url')}
				placeholder="rtsp://192.168.1.50:554/ch0"
				title="The camera's main stream, from its manual or web page. A user name and password in the address move to their own fields."
			/>
			{#if sourceError}<p class="error">{sourceError}</p>{/if}
		</div>

		<label for="cam-user-{start.id}">User name</label>
		<input id="cam-user-{start.id}" bind:value={username} autocomplete="off" />

		<label for="cam-pass-{start.id}">Password</label>
		<input
			id="cam-pass-{start.id}"
			type="password"
			bind:value={password}
			autocomplete="off"
			placeholder={passwordSaved ? 'saved' : ''}
			title="Kept in the system keychain, not in the settings. Leave blank to keep the saved one."
		/>

		<label for="cam-sub-{start.id}">Substream</label>
		<input
			id="cam-sub-{start.id}"
			bind:value={substreamUrl}
			onchange={() => takeCredentials('substream')}
			placeholder="Optional"
			title="A smaller stream from the same camera, used by the ambient log. Leave blank to use the main stream."
		/>

		<label for="cam-ptz-{start.id}">Pan/tilt</label>
		<div>
			<select
				id="cam-ptz-{start.id}"
				bind:value={ptz}
				title="ONVIF lets the assistant turn the camera. Click Connect above first."
			>
				<option value="none">None</option>
				<option value="onvif" disabled={!onvif}>ONVIF</option>
			</select>
			{#if ptz === 'onvif' && onvif}
				<p class="help presets">
					Presets: {onvif.presets.length ? onvif.presets.map((p) => p.name).join(', ') : 'none'}
				</p>
				<button
					type="button"
					class="btn btn-small"
					onclick={refreshPresets}
					disabled={refreshing}
					title="Reads the positions saved on the camera again."
				>
					{refreshing ? 'Reading…' : 'Refresh presets'}
				</button>
			{/if}
		</div>
	{:else}
		<label for="cam-video-{start.id}">Webcam</label>
		<div>
			<select
				id="cam-video-{start.id}"
				value={videoDevice}
				onchange={(e) => pickVideo(e.currentTarget.value)}
			>
				{#if !devices}<option value="">Looking…</option>{/if}
				{#if devices && devices.video.length === 0}<option value="">No webcams found</option>{/if}
				{#each devices?.video ?? [] as v (v.id)}
					<option value={v.id}>{v.name}</option>
				{/each}
			</select>
			{#if devicesError}<p class="error">{devicesError}</p>{/if}
			{#if sourceError && devices}<p class="error">{sourceError}</p>{/if}
		</div>

		<label for="cam-mic-{start.id}">Microphone</label>
		<select
			id="cam-mic-{start.id}"
			bind:value={audioDevice}
			title="The webcam's own microphone is picked when one matches its name."
		>
			<option value="">None</option>
			{#each devices?.audio ?? [] as a (a.id)}
				<option value={a.id}>{a.name}</option>
			{/each}
		</select>

		<label for="cam-uvc-{start.id}">Pan/tilt</label>
		<select
			id="cam-uvc-{start.id}"
			bind:value={ptz}
			title="UVC lets the assistant turn a webcam that can pan and tilt. Linux only."
		>
			<option value="none">None</option>
			<option value="uvc" disabled={!uvcSupported}>Pan/tilt (UVC)</option>
		</select>
	{/if}

	<span class="label">Permission</span>
	<div
		class="segmented"
		role="group"
		aria-label="Permission"
		title="Ask shows an approval prompt each time the assistant uses this camera. Jobs only use cameras set to Allow."
	>
		<button type="button" class:active={permission === 'ask'} onclick={() => (permission = 'ask')}
			>Ask</button
		>
		<button
			type="button"
			class:active={permission === 'allow'}
			onclick={() => (permission = 'allow')}>Allow</button
		>
	</div>

	<span class="label">Ambient log</span>
	<div class="watch">
		<label
			class="toggle-row"
			title="While Haruspex is open, motion or speech logs an entry: what was said, a one-line caption and one small picture. No video or sound is kept."
		>
			<input type="checkbox" bind:checked={watchOn} />
			<span>Log motion and speech</span>
		</label>
	</div>

	{#if watchOn}
		<label for="cam-from-{start.id}">Active hours</label>
		<div>
			<div class="hours">
				<select
					id="cam-from-{start.id}"
					bind:value={hoursLimited}
					title="An end before the start runs past midnight."
				>
					<option value={false}>All day</option>
					<option value={true}>Between</option>
				</select>
				{#if hoursLimited}
					<input type="time" bind:value={hoursStart} aria-label="From" />
					<span>and</span>
					<input type="time" bind:value={hoursEnd} aria-label="To" />
				{/if}
			</div>
			{#if hoursError}<p class="error">{hoursError}</p>{/if}
		</div>

		<label for="cam-motion-{start.id}">Motion</label>
		<select
			id="cam-motion-{start.id}"
			bind:value={sensitivity}
			title="How much of the picture must change to count. High notices small movements, and more false alarms."
		>
			<option value="low">Low</option>
			<option value="medium">Medium</option>
			<option value="high">High</option>
		</select>

		<label for="cam-sound-{start.id}">Sound</label>
		<div class="sound">
			<input
				id="cam-sound-{start.id}"
				type="range"
				min="-60"
				max="-10"
				step="1"
				bind:value={soundDb}
				title="How loud sound must be to log an entry. Lower catches quieter speech, and more background noise."
			/>
			<span>{Math.round(soundDb)} dB</span>
		</div>
	{/if}
</div>

{#if frame || caps || level !== null || testError}
	<div class="test-result">
		{#if frame}<img src={frame} alt="What {name.trim() || 'the camera'} sees" />{/if}
		<div class="test-notes">
			{#if caps && frame}
				<p class="help">
					{caps.width}×{caps.height}{caps.videoCodec ? ` · ${caps.videoCodec}` : ''}
				</p>
			{/if}
			{#if level !== null}
				<p class="help">Sound: {levelText(level)}</p>
				<div class="meter" aria-hidden="true">
					<div class="meter-fill" style:width="{levelPercent(level)}%"></div>
				</div>
			{:else if caps && frame && !caps.hasAudio}
				<p class="help">No sound in this stream.</p>
			{/if}
			{#if testError}<p class="error">{testError}</p>{/if}
		</div>
	</div>
{/if}

<div class="actions">
	<button
		type="button"
		class="btn btn-small"
		onclick={test}
		disabled={testing || !!sourceError}
		title="Shows a frame and listens for 3 seconds."
	>
		{testing ? 'Testing…' : 'Test'}
	</button>
	{#if savedPtz !== 'none'}
		<div class="aim" role="group" aria-label="Aim">
			{#each AIMS as a (a.direction)}
				<button
					type="button"
					class="btn btn-small"
					onclick={() => aimTest(a.direction)}
					disabled={aiming || testing || !!sourceError}
					title={a.title}>{a.label}</button
				>
			{/each}
		</div>
	{/if}
	{#if saveError}<span class="error">{saveError}</span>{/if}
	<span class="spacer"></span>
	<button type="button" class="btn btn-small" onclick={cancel}>Cancel</button>
	<button
		type="button"
		class="btn btn-primary btn-small"
		disabled={saving || !!nameError || !!sourceError || !!hoursError}
		onclick={save}>Save</button
	>
</div>

<style>
	.form {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 8px 12px;
		align-items: start;
		font-size: 0.85rem;
	}

	.form > label,
	.label {
		padding-top: 6px;
		color: var(--text-secondary);
	}

	input:not([type='checkbox']),
	select {
		width: 100%;
		box-sizing: border-box;
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
	}

	.watch {
		padding-top: 4px;
	}

	.hours,
	.sound {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.hours input,
	.hours select {
		width: auto;
	}

	.sound input {
		flex: 1;
		padding: 0;
		border: none;
		background: none;
	}

	.sound span {
		min-width: 3.5em;
		color: var(--text-secondary);
	}

	.found {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.found button {
		width: 100%;
		text-align: left;
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		cursor: pointer;
	}

	.found button.active {
		border-color: var(--accent);
	}

	.presets {
		margin-top: 6px;
	}

	.test-result {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		margin-top: 10px;
	}

	.test-result img {
		max-width: 240px;
		border-radius: 6px;
		border: 1px solid var(--border);
	}

	.test-notes {
		flex: 1;
		min-width: 0;
	}

	.meter {
		height: 6px;
		max-width: 160px;
		margin-top: 4px;
		border-radius: 3px;
		background: var(--border);
		overflow: hidden;
	}

	.meter-fill {
		height: 100%;
		background: var(--accent);
	}

	.help {
		margin: 0 0 4px;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.error {
		margin: 4px 0 0;
		color: var(--error-text);
		font-size: 0.8rem;
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
	}

	.aim {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.spacer {
		flex: 1;
	}
</style>
