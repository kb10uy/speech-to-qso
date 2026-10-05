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
		<span>Vosk model URL</span>
		<input
			type="url"
			bind:value={form.voskModelUrl}
			placeholder={app.defaultModelUrl(form.voskLanguage)}
		/>
		<span class="hint"
			>.tar.gz with a single top-level directory, in the language selected above. Empty uses the
			bundled model.</span
		>
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

<section class="help">
	<h2>Voice commands</h2>
	<p class="hint">
		One utterance per PTT press. Speaking a field again overwrites it. Commands can be chained. With
		the Japanese model, say the same words as katakana loanwords (ジュリエット リマ ワン …), and
		送信, 受信 and 周波数 for sent, received and frequency.
	</p>
	<dl>
		<dt>juliett lima one hotel india sierra</dt>
		<dd>Callsign JL1HIS (“stroke one” or “portable one” → /1, “portable” → /P)</dd>
		<dt>sent five nine · received five seven</dt>
		<dd>RST sent / received (defaults 59)</dd>
		<dt>frequency point nine four</dt>
		<dd>*.940 MHz, nearest to the anchor</dd>
		<dt>frequency two point seven four</dt>
		<dd>*2.740 MHz; “four thirty two point nine four” is fully specified</dd>
		<dt>jcx one zero zero one zero one</dt>
		<dd>JCC/JCG 100101 (also “jcc”, “jcg”)</dd>
		<dt>card requested · card negative</dt>
		<dd>QSL requested on/off</dd>
		<dt>card one way</dt>
		<dd>QSL one way: they send a card and expect none back</dd>
		<dt>mode foxtrot mike</dt>
		<dd>Mode FM (also SSB, CW, FT8, …)</dd>
	</dl>
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
	dl {
		display: grid;
		gap: 0.2rem;
	}
	dt {
		font-family: var(--mono);
		margin-top: 0.5rem;
	}
	dd {
		margin: 0;
		color: var(--muted);
		font-size: 0.9rem;
	}
</style>
