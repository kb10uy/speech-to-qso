<script lang="ts">
	import { onMount } from 'svelte';
	import { QsoApp } from '../lib/app/app.svelte';
	import BootstrapView from '../lib/components/BootstrapView.svelte';
	import LogView from '../lib/components/LogView.svelte';
	import QsoView from '../lib/components/QsoView.svelte';
	import SessionView from '../lib/components/SessionView.svelte';
	import SettingsView from '../lib/components/SettingsView.svelte';

	type Tab = 'qso' | 'session' | 'log' | 'settings';

	const app = new QsoApp();
	let tab = $state<Tab>('qso');
	let initError = $state<string | null>(null);

	onMount(() => {
		// Handy for debugging on a phone (remote devtools) and used by the e2e tests.
		(window as unknown as { __qso: QsoApp }).__qso = app;
		app.init().catch((e) => (initError = e instanceof Error ? e.message : String(e)));
	});

	function isTyping(target: EventTarget | null) {
		return target instanceof HTMLElement && target.closest('input, textarea, select') !== null;
	}

	// Space bar works as PTT on desktop.
	function keydown(e: KeyboardEvent) {
		if (tab !== 'qso' || e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
		e.preventDefault();
		void app.pttPress();
	}
	function keyup(e: KeyboardEvent) {
		if (e.code !== 'Space' || isTyping(e.target)) return;
		e.preventDefault();
		void app.pttRelease();
	}
</script>

<svelte:window onkeydown={keydown} onkeyup={keyup} />

<svelte:head>
	<title>Speech to QSO</title>
</svelte:head>

<header>
	<nav>
		<button class:current={tab === 'qso'} onclick={() => (tab = 'qso')}>QSO</button>
		<button class:current={tab === 'session'} onclick={() => (tab = 'session')}>Session</button>
		<button class:current={tab === 'log'} onclick={() => (tab = 'log')}>
			Log{#if app.unsyncedCount > 0 && app.syncConfigured}<span class="dot"
					>{app.unsyncedCount}</span
				>{/if}
		</button>
		<button class:current={tab === 'settings'} onclick={() => (tab = 'settings')}>⚙</button>
	</nav>
	<div class="status">
		{#if app.user !== null}
			<span class="mono" title="Signed in">{app.session.operatorCall || app.user.callsign}</span>
		{:else}
			<span class="mono">{app.session.operatorCall || '—'}</span>
			{#if app.account === 'signedOut'}
				<button class="sign-in" onclick={() => (tab = 'settings')}>Sign in</button>
			{/if}
		{/if}
		{#if !app.online}<span class="offline">offline</span>{/if}
	</div>
</header>

<main>
	{#if initError}
		<p class="error">Failed to start: {initError}</p>
	{:else if !app.ready}
		<p class="hint">Loading…</p>
	{:else if app.bootstrapToken !== null}
		{#key app.bootstrapToken}
			<BootstrapView {app} token={app.bootstrapToken} />
		{/key}
	{:else if tab === 'qso'}
		<QsoView {app} onOpenSession={() => (tab = 'session')} />
	{:else if tab === 'session'}
		<SessionView {app} onDone={() => (tab = 'qso')} />
	{:else if tab === 'log'}
		<LogView {app} />
	{:else}
		<SettingsView {app} />
	{/if}
</main>

<style>
	header {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		/* The bar spans the window, but its contents line up with main's on wide screens. */
		padding: calc(env(safe-area-inset-top) + 0.4rem) max(0.6rem, calc((100% - 32rem) / 2 + 0.8rem))
			0.4rem;
		background: var(--bg);
		border-bottom: 1px solid var(--border);
	}
	nav {
		display: flex;
		gap: 0.3rem;
	}
	nav button {
		padding: 0.45rem 0.7rem;
		background: transparent;
		border-color: transparent;
	}
	nav button.current {
		background: var(--surface-2);
		border-color: var(--border);
		font-weight: 600;
	}
	.dot {
		display: inline-block;
		margin-left: 0.3rem;
		min-width: 1.2rem;
		padding: 0 0.3rem;
		border-radius: 999px;
		background: var(--info);
		color: #fff;
		font-size: 0.75rem;
	}
	.status {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.offline {
		color: var(--error);
	}
	.sign-in {
		padding: 0.25rem 0.6rem;
		font-size: 0.85rem;
	}
	main {
		max-width: 32rem;
		margin: 0 auto;
		padding: 0.8rem 0.8rem calc(env(safe-area-inset-bottom) + 1.5rem);
	}
	.error {
		color: var(--error);
	}
</style>
