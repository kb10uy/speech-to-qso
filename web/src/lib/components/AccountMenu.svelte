<script lang="ts" module>
	export type MenuPage = 'settings' | 'help';
</script>

<script lang="ts">
	import type { QsoApp } from '../app/app.svelte';
	import { describeError } from '../account/api';
	import { isWebAuthnSupported } from '../account/webauthn';

	let {
		app,
		current,
		onOpen
	}: { app: QsoApp; current: MenuPage | null; onOpen: (page: MenuPage) => void } = $props();

	let open = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let root = $state<HTMLElement>();

	const callsign = $derived(app.session.operatorCall || app.user?.callsign || '');

	async function run(action: () => Promise<unknown>) {
		open = false;
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

	function show(page: MenuPage) {
		open = false;
		error = null;
		onOpen(page);
	}

	const signIn = () => run(() => app.signIn());

	const signOut = () =>
		run(async () => {
			const unsynced = app.unsyncedCount;
			if (
				unsynced > 0 &&
				!confirm(`${unsynced} QSO(s) are not synced yet. They will be sent after the next sign-in.`)
			)
				return;
			await app.signOut();
		});

	function closeOutside(e: MouseEvent) {
		if (open && !root?.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window
	onclick={closeOutside}
	onkeydown={(e) => {
		if (open && e.key === 'Escape') open = false;
	}}
/>

<div class="menu" bind:this={root}>
	<button
		class="trigger"
		class:mono={callsign !== ''}
		class:current={current !== null}
		aria-haspopup="menu"
		aria-expanded={open}
		disabled={busy}
		onclick={() => (open = !open)}
		>{callsign || 'Menu'}<span aria-hidden="true" class="caret">▾</span></button
	>
	{#if open}
		<ul role="menu">
			<li role="none">
				<button
					role="menuitem"
					class:current={current === 'settings'}
					onclick={() => show('settings')}>Settings</button
				>
			</li>
			<li role="none">
				<button role="menuitem" class:current={current === 'help'} onclick={() => show('help')}
					>Help</button
				>
			</li>
			{#if app.user !== null}
				<li role="separator"></li>
				<li role="none"><button role="menuitem" onclick={signOut}>Sign out</button></li>
			{:else if isWebAuthnSupported()}
				<li role="separator"></li>
				<li role="none"><button role="menuitem" onclick={signIn}>Sign in</button></li>
			{/if}
		</ul>
	{/if}
	{#if error}
		<div class="error" role="alert">
			<span>{error}</span>
			<button onclick={() => (error = null)} aria-label="Dismiss">×</button>
		</div>
	{/if}
</div>

<style>
	.menu {
		position: relative;
	}
	.trigger {
		padding: 0.25rem 0.5rem;
		background: transparent;
		border-color: transparent;
		color: var(--text);
	}
	.trigger.current,
	.trigger[aria-expanded='true'] {
		background: var(--surface-2);
		border-color: var(--border);
	}
	.caret {
		margin-left: 0.3rem;
		color: var(--muted);
		font-size: 0.75em;
	}
	ul,
	.error {
		position: absolute;
		right: 0;
		top: calc(100% + 0.3rem);
		z-index: 2;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0.3rem;
		min-width: 9rem;
	}
	li[role='separator'] {
		margin: 0.3rem 0;
		border-top: 1px solid var(--border);
	}
	[role='menuitem'] {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.45rem 0.7rem;
		background: transparent;
		border-color: transparent;
	}
	[role='menuitem']:hover,
	[role='menuitem'].current {
		background: var(--surface-2);
	}
	.error {
		display: flex;
		align-items: start;
		gap: 0.4rem;
		width: max-content;
		max-width: 18rem;
		padding: 0.5rem 0.4rem 0.5rem 0.7rem;
		color: var(--error);
	}
	.error button {
		padding: 0 0.4rem;
		background: transparent;
		border-color: transparent;
	}
</style>
