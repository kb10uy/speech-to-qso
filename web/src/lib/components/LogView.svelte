<script lang="ts">
	import type { QsoApp } from '../app/app.svelte';
	import { formatMhz, type QsoRecord } from '../qso';

	let { app }: { app: QsoApp } = $props();

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
</script>

<div class="toolbar">
	<span>{app.log.length} QSOs{syncConfigured ? `, ${app.unsyncedCount} unsynced` : ''}</span>
	<span class="buttons">
		{#if syncConfigured}
			<button onclick={() => void app.sync()} disabled={app.syncing || !app.online}>
				{app.syncing ? 'Syncing…' : 'Sync now'}
			</button>
		{/if}
		<button onclick={download} disabled={app.log.length === 0}>Export ADIF</button>
	</span>
</div>

{#if !app.online}
	<p class="hint">Offline — QSOs are kept on this device and synced when back online.</p>
{/if}

<ul>
	{#each app.log as record (record.id)}
		<li>
			<div class="line1">
				<strong class="mono">{record.callsign}</strong>
				<span class="badge {syncLabel(record)}" title={record.syncError ?? ''}
					>{syncLabel(record)}</span
				>
			</div>
			<div class="line2 mono">
				{time(record)}Z · {formatMhz(record.frequencyHz)}
				{record.mode} · {record.rstSent}/{record.rstReceived}
				{#if record.jcx}· JCX {record.jcx}{/if}
				{#if record.qsl === 'requested'}· QSL{:else if record.qsl === 'oneWay'}· QSL one way{/if}
			</div>
			{#if record.syncState === 'failed' && record.syncError}
				<div class="err">{record.syncError}</div>
			{/if}
			<button class="del" onclick={() => void remove(record)} aria-label="Delete">✕</button>
		</li>
	{:else}
		<li class="hint">No QSOs yet.</li>
	{/each}
</ul>

<style>
	.toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.8rem;
	}
	.buttons {
		display: flex;
		gap: 0.4rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	li {
		position: relative;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 0.6rem 2.6rem 0.6rem 0.8rem;
	}
	.line1 {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		font-size: 1.2rem;
	}
	.line2 {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.err {
		font-size: 0.8rem;
		color: var(--error);
	}
	.badge {
		font-size: 0.7rem;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--muted);
	}
	.badge.synced {
		color: var(--ok);
		border-color: var(--ok);
	}
	.badge.waiting {
		color: var(--info);
		border-color: var(--info);
	}
	.badge.failed {
		color: var(--error);
		border-color: var(--error);
	}
	.del {
		position: absolute;
		top: 0.4rem;
		right: 0.4rem;
		padding: 0.2rem 0.55rem;
		background: transparent;
		border: none;
		color: var(--muted);
	}
</style>
