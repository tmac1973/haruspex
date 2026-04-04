<script lang="ts">
	import { open } from '@tauri-apps/plugin-dialog';
	import { goto } from '$app/navigation';
	import {
		getStep,
		getHardware,
		getSelectedModel,
		getDownloadProgress,
		getDownloadError,
		getTestResult,
		getTestResponse,
		getTestStatusMessage,
		getModels,
		setStep,
		setSelectedModel,
		detectHardware,
		startDownload,
		cancelDownload,
		importModel,
		runTestQuery
	} from '$lib/stores/setup.svelte';

	const step = $derived(getStep());
	const hardware = $derived(getHardware());
	const selectedModel = $derived(getSelectedModel());
	const progress = $derived(getDownloadProgress());
	const downloadError = $derived(getDownloadError());
	const testResult = $derived(getTestResult());
	const testResponse = $derived(getTestResponse());
	const testStatusMessage = $derived(getTestStatusMessage());
	const models = $derived(getModels());

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
		return `${(bytes / 1073741824).toFixed(2)} GB`;
	}

	function formatSpeed(bps: number): string {
		if (bps < 1048576) return `${(bps / 1024).toFixed(0)} KB/s`;
		return `${(bps / 1048576).toFixed(1)} MB/s`;
	}

	function estimatedTime(progress: {
		downloaded: number;
		total: number;
		speed_bps: number;
	}): string {
		if (progress.speed_bps <= 0) return '';
		const remaining = progress.total - progress.downloaded;
		const seconds = Math.ceil(remaining / progress.speed_bps);
		if (seconds < 60) return `${seconds}s remaining`;
		if (seconds < 3600) return `${Math.ceil(seconds / 60)}m remaining`;
		return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m remaining`;
	}

	async function goToHardware() {
		setStep('hardware');
		await detectHardware();
	}

	async function goToDownload() {
		setStep('download');
		startDownload();
	}

	async function handleImport() {
		const selected = await open({
			multiple: false,
			filters: [{ name: 'GGUF Models', extensions: ['gguf'] }]
		});
		if (selected) {
			const success = await importModel(selected as string);
			if (success) {
				setStep('test');
				runTestQuery();
			}
		}
	}

	function goToTest() {
		setStep('test');
		runTestQuery();
	}

	function goToChat() {
		goto('/');
	}
</script>

<div class="wizard">
	{#if step === 'welcome'}
		<div class="wizard-step">
			<h1>Welcome to Haruspex</h1>
			<p class="subtitle">Private AI that runs entirely on your computer.</p>
			<div class="features">
				<div class="feature">
					<span class="feature-icon">&#128274;</span>
					<div>
						<strong>Completely private</strong>
						<p>Nothing you ask ever leaves your device.</p>
					</div>
				</div>
				<div class="feature">
					<span class="feature-icon">&#127760;</span>
					<div>
						<strong>Web research</strong>
						<p>Search the web for current information when needed.</p>
					</div>
				</div>
				<div class="feature">
					<span class="feature-icon">&#9889;</span>
					<div>
						<strong>No accounts needed</strong>
						<p>No sign-up, no API keys, no subscriptions.</p>
					</div>
				</div>
			</div>
			<button class="primary-btn" onclick={goToHardware}>Get Started</button>
		</div>
	{:else if step === 'hardware'}
		<div class="wizard-step">
			<h1>Checking your hardware</h1>
			{#if hardware}
				<div class="hardware-info">
					<div class="hw-row">
						<span class="hw-label">GPU</span>
						<span class="hw-value">
							{#if hardware.gpu_available}
								{hardware.gpu_name || hardware.gpu_api || 'Available'}
								<span class="badge good">{hardware.gpu_api}</span>
								{#if hardware.gpu_integrated}
									<span class="badge warn">Integrated</span>
								{/if}
							{:else}
								<span class="badge neutral">CPU only (slower but works)</span>
							{/if}
						</span>
					</div>
					{#if hardware.gpu_vram_mb}
						<div class="hw-row">
							<span class="hw-label">VRAM</span>
							<span class="hw-value">
								{formatBytes(hardware.gpu_vram_mb * 1048576)}
							</span>
						</div>
					{/if}
					<div class="hw-row">
						<span class="hw-label">RAM</span>
						<span class="hw-value">
							{formatBytes(hardware.available_ram_mb * 1048576)} available of {formatBytes(
								hardware.total_ram_mb * 1048576
							)}
						</span>
					</div>
					{#if hardware.gpu_integrated}
						<p class="hw-warn">
							Integrated graphics detected. A smaller model has been recommended for better
							performance. Discrete GPUs with 8+ GB VRAM are recommended for the full-size model.
						</p>
					{/if}
				</div>

				<div class="model-select">
					<label for="model">Model to download:</label>
					<select
						id="model"
						value={selectedModel}
						onchange={(e) => setSelectedModel((e.target as HTMLSelectElement).value)}
					>
						{#each models as model (model.id)}
							<option value={model.id}>
								{model.id === hardware.recommended_quant ? '(recommended) ' : ''}
								{model.description}
							</option>
						{/each}
					</select>
				</div>

				<div class="actions">
					<button class="primary-btn" onclick={goToDownload}>Download Model</button>
					<button class="secondary-btn" onclick={handleImport}>Use existing GGUF file</button>
				</div>
			{:else}
				<p class="loading">Detecting hardware...</p>
			{/if}
		</div>
	{:else if step === 'download'}
		<div class="wizard-step">
			<h1>Downloading model</h1>
			{#if progress}
				<div class="progress-info">
					<div class="progress-bar-container">
						<div
							class="progress-bar-fill"
							style="width: {progress.total > 0
								? (progress.downloaded / progress.total) * 100
								: 0}%"
						></div>
					</div>
					<div class="progress-details">
						<span>{formatBytes(progress.downloaded)} / {formatBytes(progress.total)}</span>
						<span>{formatSpeed(progress.speed_bps)}</span>
						<span>{estimatedTime(progress)}</span>
					</div>
					<div class="progress-percent">
						{progress.total > 0 ? Math.round((progress.downloaded / progress.total) * 100) : 0}%
					</div>
				</div>
				<button class="secondary-btn" onclick={cancelDownload}>Cancel</button>
			{/if}

			{#if downloadError}
				<div class="error-box">
					<p>{downloadError}</p>
					<button class="primary-btn" onclick={goToDownload}>Retry</button>
				</div>
			{/if}
		</div>
	{:else if step === 'test'}
		<div class="wizard-step">
			<h1>Testing the model</h1>
			{#if testResult === 'pending' || testResult === 'running'}
				<p class="loading">{testStatusMessage || 'Preparing test...'}</p>
				<div class="test-dots">
					<span class="dot"></span>
					<span class="dot"></span>
					<span class="dot"></span>
				</div>
			{:else if testResult === 'success'}
				<div class="test-success">
					<p class="test-label">Test response:</p>
					<blockquote>{testResponse}</blockquote>
					<p class="check">Everything is working!</p>
				</div>
				<button class="primary-btn" onclick={() => setStep('done')}>Continue</button>
			{:else if testResult === 'error'}
				<div class="error-box">
					<p>
						{testStatusMessage || 'Something went wrong with the test.'} The model may still work fine.
					</p>
					<div class="actions">
						<button class="primary-btn" onclick={goToTest}>Retry</button>
						<button class="secondary-btn" onclick={() => setStep('done')}>Skip</button>
					</div>
				</div>
			{/if}
		</div>
	{:else if step === 'done'}
		<div class="wizard-step">
			<h1>You're ready to use Haruspex!</h1>
			<div class="features">
				<div class="feature">
					<span class="feature-icon">&#128172;</span>
					<p>Ask questions and get helpful answers</p>
				</div>
				<div class="feature">
					<span class="feature-icon">&#128269;</span>
					<p>Haruspex can search the web for current info</p>
				</div>
				<div class="feature">
					<span class="feature-icon">&#128736;</span>
					<p>All processing happens locally on your machine</p>
				</div>
			</div>
			<button class="primary-btn" onclick={goToChat}>Start chatting</button>
		</div>
	{/if}
</div>

<style>
	.wizard {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: calc(100vh - 45px);
		padding: 32px;
	}

	.wizard-step {
		max-width: 520px;
		width: 100%;
		text-align: center;
	}

	h1 {
		font-size: 1.5rem;
		margin: 0 0 8px 0;
		color: var(--text-primary);
	}

	.subtitle {
		color: var(--text-secondary);
		margin: 0 0 32px 0;
		font-size: 1.05rem;
	}

	.features {
		text-align: left;
		margin: 24px 0 32px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.feature {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.feature-icon {
		font-size: 1.3rem;
		flex-shrink: 0;
		margin-top: 2px;
	}

	.feature strong {
		display: block;
		margin-bottom: 2px;
	}

	.feature p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.primary-btn {
		padding: 10px 28px;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		font-weight: 500;
		cursor: pointer;
	}

	.primary-btn:hover {
		opacity: 0.9;
	}

	.secondary-btn {
		padding: 10px 28px;
		background: none;
		color: var(--text-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		font-size: 0.9rem;
		cursor: pointer;
	}

	.secondary-btn:hover {
		background: var(--bg-secondary);
	}

	.actions {
		display: flex;
		gap: 12px;
		justify-content: center;
		margin-top: 24px;
	}

	/* Hardware */
	.hardware-info {
		background: var(--bg-secondary);
		border-radius: 8px;
		padding: 16px;
		margin: 24px 0;
		text-align: left;
	}

	.hw-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 0;
	}

	.hw-row + .hw-row {
		border-top: 1px solid var(--border);
	}

	.hw-label {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.hw-value {
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 500;
		margin-left: 6px;
	}

	.badge.good {
		background: #dcfce7;
		color: #166534;
	}

	.badge.neutral {
		background: var(--bg-secondary);
		color: var(--text-secondary);
		border: 1px solid var(--border);
	}

	.badge.warn {
		background: #fef3c7;
		color: #92400e;
	}

	.hw-warn {
		font-size: 0.8rem;
		color: #b45309;
		background: #fffbeb;
		border: 1px solid #fde68a;
		border-radius: 6px;
		padding: 10px 14px;
		margin-top: 12px;
		line-height: 1.5;
	}

	@media (prefers-color-scheme: dark) {
		.badge.good {
			background: #14532d;
			color: #86efac;
		}

		.badge.warn {
			background: #78350f;
			color: #fde68a;
		}

		.hw-warn {
			color: #fcd34d;
			background: #451a03;
			border-color: #78350f;
		}
	}

	.model-select {
		text-align: left;
		margin: 16px 0 24px;
	}

	.model-select label {
		display: block;
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: 6px;
	}

	.model-select select {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.model-select select option {
		background-color: var(--bg-primary);
		color: var(--text-primary);
	}

	/* Progress */
	.progress-info {
		margin: 24px 0;
	}

	.progress-bar-container {
		height: 8px;
		background: var(--bg-secondary);
		border-radius: 4px;
		overflow: hidden;
		margin-bottom: 12px;
	}

	.progress-bar-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 4px;
		transition: width 0.3s ease;
	}

	.progress-details {
		display: flex;
		justify-content: space-between;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.progress-percent {
		font-size: 1.5rem;
		font-weight: 600;
		margin-top: 8px;
		color: var(--text-primary);
	}

	/* Test */
	.loading {
		color: var(--text-secondary);
		font-size: 0.95rem;
	}

	.test-dots {
		display: flex;
		gap: 4px;
		justify-content: center;
		margin: 16px 0;
	}

	.test-dots .dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-secondary);
		animation: bounce 1.2s ease-in-out infinite;
	}

	.test-dots .dot:nth-child(2) {
		animation-delay: 0.15s;
	}

	.test-dots .dot:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes bounce {
		0%,
		60%,
		100% {
			transform: translateY(0);
			opacity: 0.4;
		}
		30% {
			transform: translateY(-4px);
			opacity: 1;
		}
	}

	.test-success blockquote {
		background: var(--bg-secondary);
		border-left: 3px solid var(--accent);
		padding: 12px 16px;
		margin: 16px 0;
		border-radius: 0 6px 6px 0;
		text-align: left;
		font-style: italic;
		color: var(--text-secondary);
	}

	.test-label {
		font-size: 0.85rem;
		color: var(--text-secondary);
		margin-bottom: 4px;
	}

	.check {
		color: #22c55e;
		font-weight: 500;
	}

	.error-box {
		background: var(--error-bg);
		color: var(--error-text);
		border: 1px solid var(--error-border);
		border-radius: 8px;
		padding: 16px;
		margin: 16px 0;
	}

	.error-box p {
		margin: 0 0 12px 0;
	}
</style>
