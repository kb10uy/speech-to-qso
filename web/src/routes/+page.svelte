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

    const tabs = [
        { id: 'qso', label: 'QSO' },
        { id: 'session', label: 'Session' }
    ] as const;

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

<header class="sticky top-0 z-1 border-b border-border bg-bg pt-[env(safe-area-inset-top)]">
    <div class="mx-auto flex max-w-lg items-center justify-between gap-2 px-3 py-1.5">
        <div class="flex min-w-0 items-center gap-2">
            <img class="size-8 flex-none" src={asset('icon.svg')} alt="Speech to QSO" />
            <nav class="flex gap-1">
                {#each tabs as { id, label } (id)}
                    <button
                        class={[
                            'px-3 py-1.5',
                            tab === id
                                ? 'border-border bg-surface-2 font-semibold'
                                : 'border-transparent bg-transparent'
                        ]}
                        onclick={() => (tab = id)}>{label}</button
                    >
                {/each}
            </nav>
        </div>
        <div class="flex items-center gap-1.5">
            {#if !app.online}<span class="text-sm text-error">offline</span>{/if}
            <AccountMenu
                {app}
                current={tab === 'log' || tab === 'settings' || tab === 'help' ? tab : null}
                onOpen={(page) => (tab = page)}
            />
        </div>
    </div>
</header>

<main class="mx-auto max-w-lg px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
    {#if initError}
        <p class="text-error">Failed to start: {initError}</p>
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
