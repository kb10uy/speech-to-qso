<script lang="ts" module>
    export type MenuPage = 'log' | 'settings' | 'help';
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
    const unsynced = $derived(app.syncConfigured ? app.unsyncedCount : 0);

    const popover =
        'absolute top-full right-0 z-2 mt-1 rounded-control border border-border bg-surface shadow-[0_6px_20px_rgb(0_0_0/0.25)]';

    function item(page?: MenuPage) {
        return [
            'block w-full border-transparent px-3 py-1.5 text-left',
            page !== undefined && current === page
                ? 'bg-surface-2'
                : 'bg-transparent hover:bg-surface-2'
        ];
    }

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
                !confirm(
                    `${unsynced} QSO(s) are not synced yet. They stay in this account until you sign in to it again.`
                )
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

<div class="relative" bind:this={root}>
    <button
        class={[
            'border-transparent bg-transparent px-3 py-1.5 text-text',
            callsign !== '' && 'font-mono',
            current !== null && 'font-semibold'
        ]}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onclick={() => (open = !open)}
        >{callsign || 'Menu'}{#if unsynced > 0}<span
                aria-hidden="true"
                class="ml-1.5 inline-block size-1.75 rounded-full bg-info align-super"
            ></span>{/if}<span aria-hidden="true" class="ml-1.5 text-[0.75em] text-muted">▾</span
        ></button
    >
    {#if open}
        <ul role="menu" class={[popover, 'm-0 min-w-36 list-none p-1']}>
            <li role="none">
                <button role="menuitem" class={item('log')} onclick={() => show('log')}
                    >Log{#if unsynced > 0}<span
                            class="ml-1.5 inline-block min-w-5 rounded-full bg-info px-1.5 text-center text-xs text-white"
                            >{unsynced}</span
                        >{/if}</button
                >
            </li>
            <li role="none">
                <button role="menuitem" class={item('settings')} onclick={() => show('settings')}
                    >Settings</button
                >
            </li>
            <li role="none">
                <button role="menuitem" class={item('help')} onclick={() => show('help')}
                    >Help</button
                >
            </li>
            {#if app.user !== null}
                <li role="separator" class="my-1 border-t border-border"></li>
                <li role="none">
                    <button role="menuitem" class={item()} onclick={signOut}>Sign out</button>
                </li>
            {:else if isWebAuthnSupported()}
                <li role="separator" class="my-1 border-t border-border"></li>
                <li role="none">
                    <button role="menuitem" class={item()} onclick={signIn}>Sign in</button>
                </li>
            {/if}
        </ul>
    {/if}
    {#if error}
        <div
            class={[popover, 'flex w-max max-w-72 items-start gap-1.5 py-2 pr-1.5 pl-3 text-error']}
            role="alert"
        >
            <span>{error}</span>
            <button
                class="border-transparent bg-transparent px-1.5 py-0"
                onclick={() => (error = null)}
                aria-label="Dismiss">×</button
            >
        </div>
    {/if}
</div>
