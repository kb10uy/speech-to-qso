<script lang="ts">
	import { onMount } from 'svelte';
	import type { QsoApp } from '../app/app.svelte';
	import { describeError, type WavelogSettings } from '../account/api';
	import { emptyStationInput, stationLabel, type Station, type StationInput } from '../qso';

	let { app }: { app: QsoApp } = $props();

	let busy = $state(false);
	let error = $state<string | null>(null);
	let wavelog = $state<WavelogSettings>({ configured: false, url: null });
	let wavelogUrl = $state('');
	let wavelogToken = $state('');
	/** The station being edited (`null` id: a new one), or `null` when the form is closed. */
	let editing = $state<{ id: string | null; input: StationInput } | null>(null);

	async function run(action: () => Promise<unknown>) {
		busy = true;
		error = null;
		try {
			await action();
		} catch (e) {
			error = describeError(e);
		} finally {
			busy = false;
		}
	}

	onMount(() =>
		run(async () => {
			wavelog = await app.api.wavelog();
			wavelogUrl = wavelog.url ?? '';
			await app.loadStations();
		})
	);

	const connect = () =>
		run(async () => {
			await app.setStations(await app.api.connectWavelog(wavelogUrl, wavelogToken));
			wavelogToken = '';
			wavelog = await app.api.wavelog();
			wavelogUrl = wavelog.url ?? '';
		});

	const disconnect = () =>
		run(async () => {
			if (!confirm('Stop forwarding QSOs to Wavelog?')) return;
			await app.api.disconnectWavelog();
			wavelog = { configured: false, url: null };
		});

	const refresh = () => run(async () => app.setStations(await app.api.refreshStations()));

	const makeDefault = (station: Station) =>
		run(async () => {
			await app.api.setDefaultStation(station.id);
			await app.loadStations();
		});

	const save = () =>
		run(async () => {
			if (editing === null) return;
			const input = $state.snapshot(editing.input);
			if (editing.id === null) await app.api.createStation(input);
			else await app.api.updateStation(editing.id, input);
			editing = null;
			await app.loadStations();
		});

	const remove = (station: Station) =>
		run(async () => {
			if (!confirm(`Delete the station “${station.name}”?`)) return;
			await app.api.deleteStation(station.id);
			await app.loadStations();
		});

	function edit(station: Station | null) {
		editing =
			station === null
				? { id: null, input: emptyStationInput(app.user?.callsign ?? '') }
				: { id: station.id, input: { ...emptyStationInput(), ...station } };
	}
</script>

<section aria-label="Wavelog">
	<h2>Wavelog</h2>
	<p class="hint">
		QSOs logged with a Wavelog station are forwarded to your Wavelog (3.1 or later). Create an API
		token with the <span class="mono">station:read</span> and <span class="mono">qso:write</span>
		scopes in Wavelog; it is stored on the server only.
	</p>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			void connect();
		}}
	>
		<label class="field">
			<span>Wavelog URL</span>
			<input type="url" bind:value={wavelogUrl} placeholder="https://log.example.com" required />
		</label>
		<label class="field">
			<span>API token</span>
			<input
				type="password"
				bind:value={wavelogToken}
				autocomplete="off"
				placeholder={wavelog.configured ? 'Saved (leave empty to keep)' : 'wl2_…'}
				required={!wavelog.configured}
			/>
		</label>
		<div class="buttons">
			<button type="submit" disabled={busy}>{wavelog.configured ? 'Save' : 'Connect'}</button>
			{#if wavelog.configured}
				<button type="button" onclick={refresh} disabled={busy}>Refresh stations</button>
				<button type="button" onclick={disconnect} disabled={busy}>Disconnect</button>
			{/if}
		</div>
	</form>
</section>

<section aria-label="Stations">
	<h2>Stations</h2>
	<p class="hint">
		A station provides the session defaults (station callsign, location, POTA reference, own
		JCC/JCG). Each device picks its station in the Session tab; ★ is used until it does.
	</p>
	<ul class="list">
		{#each app.stations.stations as station (station.id)}
			<li>
				<div>
					<strong
						>{station.id === app.stations.default_station_id ? '★ ' : ''}{stationLabel(
							station
						)}</strong
					>
					<div class="hint">
						{[station.city, station.cnty, station.pota, station.gridsquare]
							.filter((s) => s !== '')
							.join(' · ')}
					</div>
				</div>
				<span class="actions">
					{#if station.id !== app.stations.default_station_id}
						<button onclick={() => makeDefault(station)} disabled={busy} title="Make default"
							>★</button
						>
					{/if}
					{#if station.wavelog_id === null}
						<button onclick={() => edit(station)} disabled={busy}>Edit</button>
						<button onclick={() => remove(station)} disabled={busy}>Delete</button>
					{/if}
				</span>
			</li>
		{:else}
			<li class="hint">No stations yet. Connect Wavelog or add one.</li>
		{/each}
	</ul>

	{#if editing === null}
		<button onclick={() => edit(null)} disabled={busy}>Add a station</button>
	{:else}
		<form
			class="station"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<label class="field">
				<span>Name</span>
				<input type="text" bind:value={editing.input.name} required />
			</label>
			<label class="field">
				<span>Station callsign</span>
				<input
					type="text"
					bind:value={editing.input.callsign}
					autocapitalize="characters"
					required
				/>
			</label>
			<label class="field">
				<span>Location (city)</span>
				<input type="text" bind:value={editing.input.city} />
			</label>
			<label class="field">
				<span>Own JCC/JCG</span>
				<input type="text" bind:value={editing.input.cnty} inputmode="numeric" />
			</label>
			<label class="field">
				<span>POTA reference</span>
				<input type="text" bind:value={editing.input.pota} autocapitalize="characters" />
			</label>
			<label class="field">
				<span>Grid square</span>
				<input type="text" bind:value={editing.input.gridsquare} autocapitalize="characters" />
			</label>
			<div class="buttons">
				<button type="submit" disabled={busy}>Save station</button>
				<button type="button" onclick={() => (editing = null)} disabled={busy}>Cancel</button>
			</div>
		</form>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
	h2 {
		margin: 1.4rem 0 0.8rem;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.list {
		list-style: none;
		margin: 0 0 0.6rem;
		padding: 0;
		display: grid;
		gap: 0.4rem;
	}
	.list li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.5rem 0.7rem;
	}
	.actions {
		display: flex;
		gap: 0.3rem;
	}
	.actions button {
		padding: 0.35rem 0.6rem;
		font-size: 0.85rem;
	}
	.station {
		margin-top: 0.6rem;
	}
	.error {
		color: var(--error);
	}
</style>
