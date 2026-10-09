<script lang="ts">
    import { onMount } from 'svelte';
    import type { QsoApp } from '../app/app.svelte';
    import { describeError, type BootstrapInfo } from '../account/api';
    import { isWebAuthnSupported } from '../account/webauthn';

    let { app, token }: { app: QsoApp; token: string } = $props();

    /** The server forgets a started registration after five minutes. */
    const FRESH_MS = 4 * 60_000;

    let started = $state<{ info: BootstrapInfo; at: number } | null>(null);
    let name = $state('');
    let busy = $state(false);
    let error = $state<string | null>(null);

    async function start() {
        started = { info: await app.api.startBootstrap(token), at: Date.now() };
        return started.info;
    }

    onMount(() => {
        start().catch((e) => (error = describeError(e)));
    });

    async function register(e: SubmitEvent) {
        e.preventDefault();
        busy = true;
        error = null;
        try {
            const info =
                started !== null && Date.now() - started.at < FRESH_MS
                    ? started.info
                    : await start();
            started = null;
            await app.completeBootstrap(await app.api.finishBootstrap(info, name));
        } catch (e) {
            error = describeError(e);
        } finally {
            busy = false;
        }
    }
</script>

<section aria-label="Set up a passkey">
    <h2 class="mt-0 mb-5 text-2xl font-bold">Set up your passkey</h2>
    {#if started}
        <p class="my-3">
            Create the first passkey for <strong class="font-mono">{started.info.callsign}</strong>.
            You sign in with it from now on; more passkeys can be added later in Settings.
        </p>
    {:else if !error}
        <p class="hint my-3">Checking the link…</p>
    {/if}
    {#if !isWebAuthnSupported()}
        <p class="my-3 text-error">This browser does not support passkeys.</p>
    {:else}
        <form onsubmit={register}>
            <label class="field">
                <span>Passkey name</span>
                <input type="text" bind:value={name} placeholder="e.g. iPhone" />
            </label>
            <button
                type="submit"
                class="btn-primary"
                disabled={busy || (started === null && !error)}>Create passkey</button
            >
        </form>
    {/if}
    {#if error}<p class="my-3 text-error" role="alert">{error}</p>{/if}
    <button class="mt-3" onclick={() => void app.cancelBootstrap()}>Cancel</button>
</section>
