<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import type { QsoApp } from '../app/app.svelte';
    import { describeError, type WavelogSettings } from '../account/api';
    import { emptyStationInput, stationLabel, type Station, type StationInput } from '../qso';

    let { app }: { app: QsoApp } = $props();
    const userId = untrack(() => app.user?.id ?? null);

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
            await app.setStations(await app.api.connectWavelog(wavelogUrl, wavelogToken), userId);
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

    const refresh = () => run(async () => app.setStations(await app.api.refreshStations(), userId));

    const setDefault = (e: Event) =>
        run(async () => {
            const id = (e.currentTarget as HTMLSelectElement).value;
            // Reload even on failure, so the select goes back to what the server has.
            try {
                await app.api.setDefaultStation(id === '' ? null : id);
            } finally {
                await app.loadStations();
            }
        });

    // Wavelog can have many station locations; only the ones entered by hand need a row (to edit).
    const handEntered = $derived(app.stations.stations.filter((s) => s.wavelog_id === null));
    const fromWavelog = $derived(app.stations.stations.length - handEntered.length);

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
    <h2 class="mt-6 mb-3">Wavelog</h2>
    <p class="hint">
        QSOs logged with a Wavelog station are forwarded to your Wavelog (3.1 or later). Create an
        API token with the <span class="font-mono">station:read</span>,
        <span class="font-mono">qso:read</span>
        and
        <span class="font-mono">qso:write</span> scopes in Wavelog; it is stored on the server only.
    </p>
    <form
        onsubmit={(e) => {
            e.preventDefault();
            void connect();
        }}
    >
        <label class="field">
            <span>Wavelog URL</span>
            <input
                type="url"
                bind:value={wavelogUrl}
                placeholder="https://log.example.com"
                required
            />
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
        <div class="flex flex-wrap gap-1.5">
            <button type="submit" disabled={busy}>{wavelog.configured ? 'Save' : 'Connect'}</button>
            {#if wavelog.configured}
                <button type="button" onclick={refresh} disabled={busy}>Refresh stations</button>
                <button type="button" onclick={disconnect} disabled={busy}>Disconnect</button>
            {/if}
        </div>
    </form>
</section>

<section aria-label="Stations">
    <h2 class="mt-6 mb-3">Stations</h2>
    <p class="hint">
        A station provides the session defaults (station callsign, location, POTA reference, own
        JCC/JCG). Each device picks its station in the Session tab; the default is used until it
        does.
    </p>
    {#if app.stations.stations.length > 0}
        <label class="field">
            <span>Default station</span>
            <select
                value={app.stations.default_station_id ?? ''}
                onchange={setDefault}
                disabled={busy}
            >
                <option value="">None</option>
                {#each app.stations.stations as station (station.id)}
                    <option value={station.id}>{stationLabel(station)}</option>
                {/each}
            </select>
            {#if fromWavelog > 0}
                <span class="hint">
                    {fromWavelog} from Wavelog; edit them in Wavelog and Refresh stations.
                </span>
            {/if}
        </label>
    {/if}
    <ul class="m-0 mb-2.5 grid list-none gap-1.5 p-0">
        {#each handEntered as station (station.id)}
            <li
                class="flex items-center justify-between gap-2 rounded-control border border-border bg-surface px-3 py-2"
            >
                <div>
                    <strong>{stationLabel(station)}</strong>
                    <div class="hint">
                        {[station.city, station.cnty, station.pota, station.gridsquare]
                            .filter((s) => s !== '')
                            .join(' · ')}
                    </div>
                </div>
                <span class="flex gap-1">
                    <button
                        class="px-2.5 py-1.5 text-sm"
                        onclick={() => edit(station)}
                        disabled={busy}>Edit</button
                    >
                    <button
                        class="px-2.5 py-1.5 text-sm"
                        onclick={() => remove(station)}
                        disabled={busy}>Delete</button
                    >
                </span>
            </li>
        {:else}
            {#if app.stations.stations.length === 0}
                <li
                    class="hint flex items-center justify-between gap-2 rounded-control border border-border bg-surface px-3 py-2"
                >
                    No stations yet. Connect Wavelog or add one.
                </li>
            {/if}
        {/each}
    </ul>

    {#if editing === null}
        <button onclick={() => edit(null)} disabled={busy}>Add a station</button>
    {:else}
        <form
            class="mt-2.5"
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
                <input
                    type="text"
                    bind:value={editing.input.gridsquare}
                    autocapitalize="characters"
                />
            </label>
            <div class="flex flex-wrap gap-1.5">
                <button type="submit" disabled={busy}>Save station</button>
                <button type="button" onclick={() => (editing = null)} disabled={busy}
                    >Cancel</button
                >
            </div>
        </form>
    {/if}
    {#if error}<p class="text-error" role="alert">{error}</p>{/if}
</section>
