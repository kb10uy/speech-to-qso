<script lang="ts">
	import type { QsoApp } from '../app/app.svelte';
	import { describeError, type PasskeyInfo } from '../account/api';
	import { isWebAuthnSupported } from '../account/webauthn';

	let { app }: { app: QsoApp } = $props();

	let busy = $state(false);
	let error = $state<string | null>(null);
	let passkeys = $state<PasskeyInfo[]>([]);
	let newPasskeyName = $state('');

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

	async function loadPasskeys() {
		passkeys = await app.api.passkeys();
	}

	// Signing in and out happens in the header menu, possibly while this is open.
	const userId = $derived(app.user?.id ?? null);
	$effect(() => {
		if (userId === null) passkeys = [];
		else void run(loadPasskeys);
	});

	const addPasskey = () =>
		run(async () => {
			await app.api.addPasskey(newPasskeyName);
			newPasskeyName = '';
			await loadPasskeys();
		});

	const rename = (passkey: PasskeyInfo) =>
		run(async () => {
			const name = prompt('Passkey name', passkey.name);
			if (name === null) return;
			await app.api.renamePasskey(passkey.id, name);
			await loadPasskeys();
		});

	const remove = (passkey: PasskeyInfo) =>
		run(async () => {
			if (!confirm(`Delete the passkey “${passkey.name}”? It can no longer be used to sign in.`))
				return;
			await app.api.deletePasskey(passkey.id);
			await loadPasskeys();
		});

	const date = (iso: string | null) => (iso === null ? 'never' : iso.slice(0, 10));
</script>

<section aria-label="Account">
	<h2>Account</h2>
	{#if app.user === null}
		<p class="hint">
			Sign in from the menu at the top right to sync QSOs to the server (and on to Wavelog). Without
			signing in, QSOs stay on this device.
		</p>
		{#if !isWebAuthnSupported()}
			<p class="error">This browser does not support passkeys.</p>
		{/if}
		{#if app.account === 'unavailable'}
			<p class="hint">The server cannot be reached right now.</p>
		{/if}
	{:else}
		<p>Signed in as <strong class="mono">{app.user.callsign}</strong></p>

		<h3>Passkeys</h3>
		<ul class="list">
			{#each passkeys as passkey (passkey.id)}
				<li>
					<div>
						<strong>{passkey.name}</strong>
						<div class="hint">
							added {date(passkey.created_at)} · last used {date(passkey.last_used_at)}
						</div>
					</div>
					<span class="actions">
						<button onclick={() => rename(passkey)} disabled={busy}>Rename</button>
						<button
							onclick={() => remove(passkey)}
							disabled={busy || passkeys.length === 1}
							title={passkeys.length === 1 ? 'The last passkey cannot be deleted' : ''}
							>Delete</button
						>
					</span>
				</li>
			{/each}
		</ul>
		<form
			class="add"
			onsubmit={(e) => {
				e.preventDefault();
				void addPasskey();
			}}
		>
			<input
				type="text"
				bind:value={newPasskeyName}
				placeholder="Name, e.g. iPhone"
				aria-label="New passkey name"
			/>
			<button type="submit" disabled={busy}>Add a passkey</button>
		</form>
		<p class="hint">Add a passkey for each device or password manager you sign in with.</p>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
	h2 {
		margin: 0 0 0.8rem;
	}
	h3 {
		margin: 1rem 0 0.5rem;
		font-size: 1rem;
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
	.add {
		display: flex;
		gap: 0.4rem;
	}
	.add button {
		white-space: nowrap;
	}
	.error {
		color: var(--error);
	}
</style>
