<script lang="ts">
	import { untrack } from 'svelte';
	import type { QsoApp } from '../app/app.svelte';
	import { applyStation, formatMhz, parseMhz, stationLabel } from '../qso';

	let { app, onDone }: { app: QsoApp; onDone: () => void } = $props();

	// Edit a copy; nothing changes until Save.
	let form = $state(
		untrack(() => ({
			...app.session,
			potaReference: app.session.potaReference ?? '',
			myJcx: app.session.myJcx ?? '',
			stationCallsign: app.session.stationCallsign ?? '',
			anchor: formatMhz(app.session.frequencyAnchorHz)
		}))
	);
	const anchorHz = $derived(parseMhz(form.anchor));

	/** Picking a station fills in its defaults; they can still be edited before saving. */
	function pickStation(e: Event) {
		const station = app.stations.stations.find(
			(s) => s.id === (e.currentTarget as HTMLSelectElement).value
		);
		if (station === undefined) return;
		const applied = applyStation({ ...app.session, operatorCall: form.operatorCall }, station);
		form = {
			...form,
			stationId: applied.stationId,
			stationCallsign: applied.stationCallsign ?? '',
			location: applied.location,
			potaReference: applied.potaReference ?? '',
			myJcx: applied.myJcx ?? ''
		};
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (anchorHz === undefined) return;
		const { anchor: _, ...rest } = form;
		await app.saveSession({
			...rest,
			operatorCall: rest.operatorCall.trim().toUpperCase(),
			stationCallsign: rest.stationCallsign.trim().toUpperCase() || undefined,
			defaultMode: rest.defaultMode.trim().toUpperCase() || 'FM',
			frequencyAnchorHz: anchorHz
		});
		onDone();
	}
</script>

<form onsubmit={save}>
	<h2>Operating session</h2>
	{#if app.stations.stations.length > 0}
		<label class="field">
			<span>Station</span>
			<select value={form.stationId ?? ''} onchange={pickStation}>
				{#if form.stationId === undefined}<option value="" disabled>Choose a station</option>{/if}
				{#each app.stations.stations as station (station.id)}
					<option value={station.id}>{stationLabel(station)}</option>
				{/each}
			</select>
			<span class="hint">Fills in the fields below. Manage stations in Settings.</span>
		</label>
	{/if}
	<label class="field">
		<span>Operator callsign</span>
		<input
			class="callsign"
			type="text"
			bind:value={form.operatorCall}
			autocapitalize="characters"
			required
		/>
	</label>
	<label class="field">
		<span>Station callsign (if not the operator's)</span>
		<input
			class="callsign"
			type="text"
			bind:value={form.stationCallsign}
			autocapitalize="characters"
		/>
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
			placeholder="JP-0000"
		/>
	</label>
	<button type="submit" class="primary" disabled={anchorHz === undefined}>Save</button>
</form>

<style>
	h2 {
		margin-top: 0;
	}
	.callsign {
		text-transform: uppercase;
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
