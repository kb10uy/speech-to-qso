<script lang="ts">
	import { untrack } from 'svelte';
	import type { QsoApp } from '../app/app.svelte';
	import type { AppSettings } from '../app/settings';
	import AccountView from './AccountView.svelte';
	import StationsView from './StationsView.svelte';

	let { app }: { app: QsoApp } = $props();

	// Edit a copy; nothing changes until Save.
	let form = $state<AppSettings>(untrack(() => $state.snapshot(app.settings)));
	let saved = $state(false);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		await app.saveSettings($state.snapshot(form));
		saved = true;
		setTimeout(() => (saved = false), 2000);
	}
</script>

<AccountView {app} />
{#if app.user !== null}
	<StationsView {app} />
{/if}

<form onsubmit={save}>
	<h2>Speech recognition</h2>
	<label class="field">
		<span>Vosk model</span>
		<select bind:value={form.voskLanguage}>
			<option value="en">English</option>
			<option value="ja">Japanese (Japanese pronunciation)</option>
		</select>
		<span class="hint">
			Hears the commands the way they are said in Japanese: <em>ゼロ ワン</em>,
			<em>ジュリエット リマ ワン</em>, and <em>送信</em>, <em>受信</em>, <em>周波数</em> for sent, received
			and frequency.
		</span>
	</label>
	<label class="field">
		<span>Release tail (ms)</span>
		<input type="number" min="0" max="2000" step="50" bind:value={form.releaseTailMs} />
		<span class="hint">Keeps listening briefly after the button is released.</span>
	</label>
	<label class="check">
		<input type="checkbox" bind:checked={form.keepScreenOn} />
		Keep the screen on while operating
	</label>

	<button type="submit" class="primary">{saved ? 'Saved ✓' : 'Save'}</button>
</form>

<section class="status">
	<p>
		Speech engine: <strong>{app.asr}</strong>
		{#if app.asrError}<span class="error">({app.asrError})</span>{/if}
	</p>
	<button onclick={() => void app.loadAsr()} disabled={app.asr === 'loading'}
		>Reload speech engine</button
	>
</section>

<style>
	h2 {
		margin: 1.2rem 0 0.8rem;
	}
	form h2:first-child {
		margin-top: 1.4rem;
	}
	.check {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		margin-bottom: 0.9rem;
	}
	.check input {
		width: 1.3rem;
		height: 1.3rem;
	}
	.primary {
		width: 100%;
		background: var(--accent);
		color: var(--accent-text);
		border: none;
		font-weight: 700;
		padding: 0.9rem;
	}
	.status {
		margin-top: 1.2rem;
	}
	.error {
		color: var(--error);
	}
</style>
