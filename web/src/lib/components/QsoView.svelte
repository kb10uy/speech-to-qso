<script lang="ts">
	import type { QsoApp } from '../app/app.svelte';
	import { formatMhz, sessionProblems } from '../qso';
	import PttButton from './PttButton.svelte';

	let { app, onOpenSession }: { app: QsoApp; onOpenSession: () => void } = $props();

	let command = $state('');
	let commandInput = $state<HTMLInputElement | null>(null);
	let commandOpen = $state(false);

	const draft = $derived(app.draft);
	const problems = $derived(sessionProblems(app.session));
	const startedAt = $derived(
		draft.startedAt === undefined ? null : new Date(draft.startedAt).toISOString().slice(11, 16)
	);

	function submitCommand(e: SubmitEvent) {
		e.preventDefault();
		if (command.trim() === '') return;
		app.handleText(command, 'typed');
		command = '';
	}

	/** Tapping a field pre-fills the command box with its keyword. */
	function edit(keyword: string) {
		commandOpen = true;
		command = keyword === '' ? '' : `${keyword} `;
		queueMicrotask(() => commandInput?.focus());
	}
</script>

{#if problems.length > 0}
	<button class="banner" onclick={onOpenSession}>
		{problems.join(' / ')} — tap to set up the session
	</button>
{/if}

<section class="draft" aria-label="Draft QSO">
	<button class="cell callsign mono" class:empty={!draft.callsign} onclick={() => edit('')}>
		{draft.callsign ?? 'CALLSIGN'}
	</button>

	<div class="row">
		<button class="cell rst" onclick={() => edit('sent')}>
			<span class="key">S</span><span class="mono">{draft.rstSent}</span>
		</button>
		<button class="cell rst" onclick={() => edit('received')}>
			<span class="key">R</span><span class="mono">{draft.rstReceived}</span>
		</button>
	</div>

	<div class="row">
		<button
			class="cell freq"
			class:empty={draft.frequencyHz === undefined}
			onclick={() => edit('frequency')}
		>
			<span class="mono"
				>{draft.frequencyHz === undefined ? '---.---' : formatMhz(draft.frequencyHz)}</span
			>
			<span class="unit">MHz</span>
		</button>
		<button class="cell mode mono" onclick={() => edit('mode')}>
			{draft.mode ?? app.session.defaultMode}
		</button>
	</div>

	<div class="row">
		<button class="cell" class:empty={!draft.jcx} onclick={() => edit('jcx')}>
			<span class="key">JCX</span><span class="mono">{draft.jcx ?? '—'}</span>
		</button>
		<button class="cell" class:qsl={draft.qslRequested} onclick={() => edit('card')}>
			{draft.qslRequested ? 'QSL Requested' : 'No QSL'}
		</button>
	</div>

	<div class="meta">
		<span>anchor {formatMhz(app.session.frequencyAnchorHz)} MHz</span>
		{#if startedAt}<span>UTC {startedAt}</span>{/if}
	</div>
</section>

<div class="feedback {app.feedback?.kind ?? 'none'}" role="status" aria-live="polite">
	{#if app.feedback}
		{#if app.feedback.heard !== undefined}
			<div class="heard">“{app.feedback.heard}”</div>
		{/if}
		<div>{app.feedback.message}</div>
	{:else}
		<div class="hint">Hold the button and speak, e.g. “received five seven”.</div>
	{/if}
</div>

{#if app.asr === 'ready'}
	<PttButton {app} />
{:else}
	<div class="asr">
		{#if app.asr === 'loading'}
			<p>Loading speech engine… (the first load downloads the model, ≈40 MB)</p>
		{:else}
			{#if app.asr === 'error'}
				<p class="error">Speech engine failed: {app.asrError}</p>
			{/if}
			<button class="load" onclick={() => void app.loadAsr()}>
				Load speech engine ({app.settings.asrEngine === 'vosk'
					? 'Vosk, ≈40 MB once'
					: 'Web Speech API'})
			</button>
		{/if}
	</div>
{/if}

<div class="actions">
	<button class="log" onclick={() => void app.logQso()} disabled={app.ptt !== 'idle'}
		>LOG QSO</button
	>
	<button class="clear" onclick={() => void app.clearDraft()}>Clear</button>
</div>

<details bind:open={commandOpen}>
	<summary>Type a command</summary>
	<form onsubmit={submitCommand} class="command">
		<input
			bind:this={commandInput}
			bind:value={command}
			type="text"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			placeholder="e.g. jl1his / received 57 / freq .94"
		/>
		<button type="submit">Apply</button>
	</form>
</details>

{#if app.utterances.length > 0}
	<details>
		<summary>Recent utterances ({app.utterances.length})</summary>
		<ol class="utterances">
			{#each app.utterances as u (u.at + u.text)}
				<li class:bad={!u.ok}>
					<span class="mono">{u.source === 'typed' ? '⌨' : '🎙'} {u.text || '(nothing)'}</span>
					<span class="hint">{u.message}</span>
				</li>
			{/each}
		</ol>
	</details>
{/if}

<style>
	.banner {
		width: 100%;
		margin-bottom: 0.8rem;
		background: color-mix(in srgb, var(--accent) 20%, transparent);
		border-color: var(--accent);
		text-align: left;
	}
	.draft {
		display: grid;
		gap: 0.5rem;
	}
	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}
	.cell {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.6rem 0.8rem;
		font-size: 1.4rem;
		display: flex;
		align-items: baseline;
		justify-content: center;
		gap: 0.5rem;
		min-height: 3.4rem;
	}
	.cell.empty {
		color: var(--muted);
	}
	.callsign {
		font-size: clamp(2.2rem, 12vw, 3.6rem);
		font-weight: 700;
		letter-spacing: 0.04em;
		padding: 0.8rem;
	}
	.callsign.empty {
		font-size: 1.6rem;
		letter-spacing: 0.2em;
	}
	.key {
		font-size: 0.9rem;
		color: var(--muted);
	}
	.rst .mono {
		font-size: 1.8rem;
		font-weight: 600;
	}
	.freq .mono {
		font-size: 1.6rem;
		font-weight: 600;
	}
	.unit {
		font-size: 0.9rem;
		color: var(--muted);
	}
	.row:has(.freq) {
		grid-template-columns: 2fr 1fr;
	}
	.qsl {
		color: var(--accent);
		border-color: var(--accent);
		font-weight: 600;
	}
	.meta {
		display: flex;
		justify-content: space-between;
		font-size: 0.8rem;
		color: var(--muted);
		padding: 0 0.3rem;
	}
	.feedback {
		margin: 0.8rem 0;
		min-height: 3.2rem;
		padding: 0.5rem 0.8rem;
		border-radius: 10px;
		border-left: 4px solid var(--border);
		background: var(--surface);
		font-size: 0.95rem;
	}
	.feedback.ok {
		border-left-color: var(--ok);
	}
	.feedback.error {
		border-left-color: var(--error);
	}
	.feedback.info {
		border-left-color: var(--info);
	}
	.feedback.error > div:last-child {
		color: var(--error);
	}
	.heard {
		font-family: var(--mono);
		color: var(--muted);
		font-size: 0.85rem;
		word-break: break-word;
	}
	.asr {
		min-height: 9rem;
		display: grid;
		place-content: center;
		text-align: center;
		border: 2px dashed var(--border);
		border-radius: 22px;
		padding: 1rem;
	}
	.asr .error {
		color: var(--error);
	}
	.load {
		font-size: 1.1rem;
		padding: 0.9rem 1.2rem;
	}
	.actions {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.5rem;
		margin-top: 0.8rem;
	}
	.log {
		background: var(--log);
		color: #fff;
		border: none;
		font-size: 1.4rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		padding: 1rem;
		border-radius: 16px;
	}
	.clear {
		border-radius: 16px;
	}
	details {
		margin-top: 0.8rem;
	}
	.command {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.5rem;
	}
	.utterances {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.4rem;
	}
	.utterances li {
		display: grid;
		font-size: 0.85rem;
		padding: 0.3rem 0.5rem;
		border-left: 3px solid var(--ok);
	}
	.utterances li.bad {
		border-left-color: var(--error);
	}
</style>
