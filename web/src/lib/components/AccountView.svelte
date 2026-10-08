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
            if (
                !confirm(
                    `Delete the passkey “${passkey.name}”? It can no longer be used to sign in.`
                )
            )
                return;
            await app.api.deletePasskey(passkey.id);
            await loadPasskeys();
        });

    const date = (iso: string | null) => (iso === null ? 'never' : iso.slice(0, 10));
</script>

<section aria-label="Account">
    <h2 class="mt-0 mb-3">Account</h2>
    {#if app.user === null}
        <p class="hint">
            Sign in from the menu at the top right to sync QSOs to the server (and on to Wavelog).
            Without signing in, QSOs stay on this device.
        </p>
        {#if !isWebAuthnSupported()}
            <p class="text-error">This browser does not support passkeys.</p>
        {/if}
        {#if app.account === 'unavailable'}
            <p class="hint">The server cannot be reached right now.</p>
        {/if}
    {:else}
        <p>Signed in as <strong class="font-mono">{app.user.callsign}</strong></p>

        <h3 class="mt-4 mb-2 text-base">Passkeys</h3>
        <ul class="m-0 mb-2.5 grid list-none gap-1.5 p-0">
            {#each passkeys as passkey (passkey.id)}
                <li
                    class="flex items-center justify-between gap-2 rounded-control border border-border bg-surface px-3 py-2"
                >
                    <div>
                        <strong>{passkey.name}</strong>
                        <div class="hint">
                            added {date(passkey.created_at)} · last used {date(
                                passkey.last_used_at
                            )}
                        </div>
                    </div>
                    <span class="flex gap-1">
                        <button
                            class="px-2.5 py-1.5 text-sm"
                            onclick={() => rename(passkey)}
                            disabled={busy}>Rename</button
                        >
                        <button
                            class="px-2.5 py-1.5 text-sm"
                            onclick={() => remove(passkey)}
                            disabled={busy || passkeys.length === 1}
                            title={passkeys.length === 1
                                ? 'The last passkey cannot be deleted'
                                : ''}>Delete</button
                        >
                    </span>
                </li>
            {/each}
        </ul>
        <form
            class="flex gap-1.5"
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
            <button class="whitespace-nowrap" type="submit" disabled={busy}>Add a passkey</button>
        </form>
        <p class="hint">Add a passkey for each device or password manager you sign in with.</p>
    {/if}
    {#if error}<p class="text-error" role="alert">{error}</p>{/if}
</section>
