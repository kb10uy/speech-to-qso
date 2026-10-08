<script lang="ts">
    import { onMount } from 'svelte';
    import { asset } from '$app/paths';
    import { QsoApp } from '../lib/app/app.svelte';
    import AccountMenu from '../lib/components/AccountMenu.svelte';
    import BootstrapView from '../lib/components/BootstrapView.svelte';
    import HelpView from '../lib/components/HelpView.svelte';
    import LogView from '../lib/components/LogView.svelte';
    import QsoView from '../lib/components/QsoView.svelte';
    import SessionView from '../lib/components/SessionView.svelte';
    import SettingsView from '../lib/components/SettingsView.svelte';

    type Tab = 'qso' | 'session' | 'log' | 'settings' | 'help';

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
    <div class="brand">
        <img class="icon" src={asset('icon.svg')} alt="Speech to QSO" />
        <nav>
            <button class:current={tab === 'qso'} onclick={() => (tab = 'qso')}>QSO</button>
            <button class:current={tab === 'session'} onclick={() => (tab = 'session')}>
                Session
            </button>
        </nav>
    </div>
    <div class="status">
        {#if !app.online}<span class="offline">offline</span>{/if}
        <AccountMenu
            {app}
            current={tab === 'log' || tab === 'settings' || tab === 'help' ? tab : null}
            onOpen={(page) => (tab = page)}
        />
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
    {:else}
        {#key app.user?.id}
            {#if tab === 'qso'}
                <QsoView {app} onOpenSession={() => (tab = 'session')} />
            {:else if tab === 'session'}
                <SessionView {app} onDone={() => (tab = 'qso')} />
            {:else if tab === 'log'}
                <LogView {app} />
            {:else if tab === 'settings'}
                <SettingsView {app} />
            {:else}
                <HelpView />
            {/if}
        {/key}
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
        padding: calc(env(safe-area-inset-top) + 0.4rem)
            max(0.6rem, calc((100% - 32rem) / 2 + 0.8rem)) 0.4rem;
        background: var(--bg);
        border-bottom: 1px solid var(--border);
    }
    .brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
    }
    .icon {
        flex: none;
        width: 2rem;
        height: 2rem;
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
    .status {
        display: flex;
        gap: 0.4rem;
        align-items: center;
    }
    .offline {
        font-size: 0.85rem;
        color: var(--error);
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
