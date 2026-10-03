<script lang="ts">
	import { untrack } from 'svelte';
	import type { QsoApp } from '../app/app.svelte';
	import { formatMhz, parseMhz } from '../qso';

	let { app, onDone }: { app: QsoApp; onDone: () => void } = $props();

	// Edit a copy; nothing changes until Save.
	let form = $state(
		untrack(() => ({
			...app.session,
			potaReference: app.session.potaReference ?? '',
			myJcx: app.session.myJcx ?? '',
			stationProfileId: app.session.stationProfileId ?? '',
			anchor: formatMhz(app.session.frequencyAnchorHz)
		}))
	);
	const anchorHz = $derived(parseMhz(form.anchor));

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (anchorHz === undefined) return;
		const { anchor: _, ...rest } = form;
		await app.saveSession({
			...rest,
			operatorCall: rest.operatorCall.trim().toUpperCase(),
			defaultMode: rest.defaultMode.trim().toUpperCase() || 'FM',
			frequencyAnchorHz: anchorHz
		});
		onDone();
	}
</script>

<form onsubmit={save}>
	<h2>Operating session</h2>
	<label class="field">
		<span>Operator callsign</span>
		<input type="text" bind:value={form.operatorCall} autocapitalize="characters" required />
	</label>
	<label class="field">
		<span>Operating location</span>
		<input type="text" bind:value={form.location} />
	</label>
	<label class="field">
		<span>Own JCC/JCG (optional)</span>
		<input type="text" bind:value={form.myJcx} inputmode="numeric" />
	</label>
	<label class="field">
		<span>Frequency anchor (MHz)</span>
		<input type="text" bind:value={form.anchor} inputmode="decimal" />
		<span class="hint">
			Partially spoken frequencies snap to the nearest match around this, e.g. with 433.000,
			“frequency point nine four” → 432.940.
		</span>
		{#if anchorHz === undefined}<span class="error">Enter a frequency in MHz</span>{/if}
	</label>
	<label class="field">
		<span>Default mode</span>
		<input type="text" bind:value={form.defaultMode} autocapitalize="characters" />
	</label>
	<label class="field">
		<span>POTA reference (optional)</span>
		<input
			type="text"
			bind:value={form.potaReference}
			autocapitalize="characters"
			placeholder="JA-0000"
		/>
	</label>
	<label class="field">
		<span>Wavelog station location id (optional)</span>
		<input type="text" bind:value={form.stationProfileId} inputmode="numeric" />
		<span class="hint">Empty uses the backend's default station.</span>
	</label>
	<button type="submit" class="primary" disabled={anchorHz === undefined}>Save</button>
</form>

<style>
	h2 {
		margin-top: 0;
	}
	.error {
		color: var(--error);
		font-size: 0.85rem;
	}
	.primary {
		width: 100%;
		background: var(--accent);
		color: var(--accent-text);
		border: none;
		font-weight: 700;
		padding: 0.9rem;
	}
</style>
