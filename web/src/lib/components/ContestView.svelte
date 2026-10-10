<script lang="ts">
    import { untrack } from 'svelte';
    import type { QsoApp } from '../app/app.svelte';
    import { contestProblems, exchangeString, expandExchange, type ContestSettings } from '../qso';

    let { app, onDone }: { app: QsoApp; onDone: () => void } = $props();

    // Edit a copy; nothing changes until Save.
    let form = $state<ContestSettings>(untrack(() => $state.snapshot(app.contest)));
    const problems = $derived(contestProblems({ ...form, enabled: true }));
    const preview = $derived(
        exchangeString(
            form,
            app.draft.rstSent,
            expandExchange(form.exchangeTemplate, form.nextSerial) || undefined
        ) ?? '(nothing)'
    );

    async function save(e: SubmitEvent) {
        e.preventDefault();
        if (form.enabled && problems.length > 0) return;
        await app.saveContest({
            ...$state.snapshot(form),
            contestId: form.contestId.trim().toUpperCase()
        });
        onDone();
    }
</script>

<form onsubmit={save}>
    <h2 class="mt-0 mb-5 text-2xl font-bold">Contest</h2>
    <label class="mb-3.5 flex items-center gap-2.5">
        <input class="size-5" type="checkbox" bind:checked={form.enabled} />
        Log QSOs as contest QSOs
    </label>
    <p class="hint my-3">
        Every QSO then needs the received number (“number one zero zero one mike”), and both numbers
        are recorded.
    </p>
    <label class="field">
        <span>Contest ID</span>
        <input
            class="uppercase"
            type="text"
            bind:value={form.contestId}
            autocapitalize="characters"
            placeholder="e.g. ALL-JA1"
        />
        <span class="hint">ADIF CONTEST_ID; may be left empty.</span>
    </label>
    <label class="field">
        <span>Sent number</span>
        <input
            type="text"
            bind:value={form.exchangeTemplate}
            autocapitalize="characters"
            autocomplete="off"
            spellcheck="false"
            placeholder={'{serial}'}
        />
        <span class="hint">
            <code>{'{serial}'}</code> is the serial number (<code>001</code>),
            <code>{'{serial:4}'}</code>
            pads it to 4 digits; everything else is sent as it is, e.g. <code>1001M</code> or
            <code>{'{serial}'}H</code>.
        </span>
    </label>
    <label class="field">
        <span>Next serial number</span>
        <input type="number" min="1" step="1" bind:value={form.nextSerial} />
        <span class="hint">Goes up by one with every logged QSO that sends it.</span>
    </label>
    <label class="mb-3.5 flex items-center gap-2.5">
        <input class="size-5" type="checkbox" bind:checked={form.includeRst} />
        Put the RST in front of the numbers (STX_STRING / SRX_STRING)
    </label>
    <p class="my-3">
        Next STX_STRING: <strong class="font-mono" aria-label="Next sent number">{preview}</strong>
    </p>
    {#each problems as problem (problem)}
        <p class="my-1 text-sm text-error">{problem}</p>
    {/each}
    <button type="submit" class="btn-primary" disabled={form.enabled && problems.length > 0}
        >Save</button
    >
</form>
