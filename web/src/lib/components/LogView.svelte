<script lang="ts">
    import type { QsoApp } from '../app/app.svelte';
    import { modeLabel } from '../dsl';
    import { formatMhz, type QsoRecord } from '../qso';

    let { app }: { app: QsoApp } = $props();
    let importing = $state(false);
    let importError = $state<string | null>(null);

    const syncConfigured = $derived(app.syncConfigured);

    function time(record: QsoRecord) {
        const iso = new Date(record.timeOn).toISOString();
        return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
    }

    function syncLabel(record: QsoRecord) {
        if (record.syncState === 'synced') return 'synced';
        if (!syncConfigured) return 'local';
        return record.syncState === 'failed' ? 'failed' : 'waiting';
    }

    const badgeColors: Record<ReturnType<typeof syncLabel>, string> = {
        synced: 'border-ok text-ok',
        waiting: 'border-info text-info',
        failed: 'border-error text-error',
        local: 'border-border text-muted'
    };

    function download() {
        const url = URL.createObjectURL(app.exportAdif());
        const a = document.createElement('a');
        a.href = url;
        a.download = `qso-${new Date().toISOString().slice(0, 10)}.adi`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function remove(record: QsoRecord) {
        if (confirm(`Delete ${record.callsign} at ${time(record)} UTC from this device?`)) {
            await app.deleteQso(record.id);
        }
    }

    async function importLocal() {
        if (
            !confirm(
                `Move ${app.localQsoCount} local QSO(s) into ${app.user?.callsign}'s account and sync them?`
            )
        )
            return;
        importing = true;
        importError = null;
        try {
            await app.importLocalQsos();
        } catch (e) {
            importError = e instanceof Error ? e.message : String(e);
        } finally {
            importing = false;
        }
    }
</script>

<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <span>{app.log.length} QSOs{syncConfigured ? `, ${app.unsyncedCount} unsynced` : ''}</span>
    <span class="flex gap-1.5">
        {#if syncConfigured}
            <button onclick={() => void app.sync()} disabled={app.syncing || !app.online}>
                {app.syncing ? 'Syncing…' : 'Sync now'}
            </button>
        {/if}
        <button onclick={download} disabled={app.log.length === 0}>Export ADIF</button>
    </span>
</div>
{#if app.user !== null}
    {#if app.localQsoCount > 0}
        <p class="hint my-3">
            {app.localQsoCount} local QSO(s) are kept separately from this account.
            <button onclick={() => void importLocal()} disabled={importing}
                >Import local QSOs</button
            >
        </p>
        {#if importError}<p class="my-3 text-xs text-error" role="alert">{importError}</p>{/if}
    {/if}
    <p class="hint my-3">
        Export ADIF saves the QSOs on this device. <a
            class="text-info underline"
            href="/api/qso.adi"
            download>Download the server log</a
        > for every QSO synced from any device.
    </p>
{/if}

{#if !app.online}
    <p class="hint my-3">Offline — QSOs are kept on this device and synced when back online.</p>
{/if}

<ul class="m-0 grid list-none gap-2 p-0">
    {#each app.log as record (record.id)}
        {@const mode = modeLabel(record)}
        <li class="relative rounded-card border border-border bg-surface py-2.5 pr-10 pl-3">
            <div class="flex items-center gap-2.5 text-xl">
                <strong class="font-mono">{record.callsign}</strong>
                <span
                    class={[
                        'rounded-full border px-2 py-0.5 text-xs',
                        badgeColors[syncLabel(record)]
                    ]}
                    title={record.syncError ?? ''}>{syncLabel(record)}</span
                >
            </div>
            <div class="font-mono text-sm text-muted">
                {time(record)}Z · {formatMhz(record.frequencyHz)}
                {mode.label}{#if mode.detail}<span class="ml-1 text-xs">{mode.detail}</span>{/if}
                · {record.rstSent}/{record.rstReceived}
                {#if record.jcx}· JCC/JCG {record.jcx}{/if}
                {#if record.qsl === 'requested'}· QSL{:else if record.qsl === 'oneWay'}· QSL one way{/if}
            </div>
            {#if record.name || record.qth}
                <div class="text-sm text-muted">
                    {[record.name, record.qth].filter(Boolean).join(' · ')}
                </div>
            {/if}
            {#if record.syncState === 'failed' && record.syncError}
                <div class="text-xs text-error">{record.syncError}</div>
            {/if}
            <button
                class="absolute top-1.5 right-1.5 border-none bg-transparent px-2 py-1 text-muted"
                onclick={() => void remove(record)}
                aria-label="Delete">✕</button
            >
        </li>
    {:else}
        <li class="hint relative rounded-card border border-border bg-surface py-2.5 pr-10 pl-3">
            No QSOs yet.
        </li>
    {/each}
</ul>
