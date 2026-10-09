<script lang="ts">
    import { untrack } from 'svelte';
    import type { QsoApp } from '../app/app.svelte';
    import {
        FREE_TEXT_MAX_LENGTH,
        formatMhz,
        formatUtcDate,
        sessionProblems,
        type FreeTextField
    } from '../qso';
    import { flash } from './flash';
    import PttButton from './PttButton.svelte';

    let { app, onOpenSession }: { app: QsoApp; onOpenSession: () => void } = $props();

    let command = $state('');
    let commandInput = $state<HTMLInputElement | null>(null);
    let commandOpen = $state(false);
    let draftSection = $state<HTMLElement | null>(null);

    const draft = $derived(app.draft);
    const problems = $derived(sessionProblems(app.session));
    const history = $derived(app.history?.callsign === draft.callsign ? app.history : null);
    const found = $derived(history?.status === 'ready' ? history.history : null);
    const blank = $derived(history?.status === 'loading' ? '…' : '—');

    function date(iso: string | null): string {
        return iso === null ? '—' : formatUtcDate(iso);
    }

    $effect(() => {
        const callsign = draft.callsign;
        if (callsign === undefined || app.account !== 'signedIn' || !app.online) return;
        untrack(() => void app.lookUpHistory(callsign));
    });

    $effect(() =>
        app.onUtterance(({ source, ok, fields }) => {
            if (!ok && source === 'typed') void flash(() => commandInput, 'flash-error');
            for (const field of fields) {
                void flash(() => draftSection?.querySelector(`[data-field="${field}"]`), 'flash');
            }
        })
    );

    function submitCommand(e: SubmitEvent) {
        e.preventDefault();
        if (command.trim() === '') return;
        app.handleText(command, 'typed');
        command = '';
    }

    const cell = 'flex min-h-14 justify-center rounded-card border bg-surface px-3';
    const button = [cell, 'items-baseline gap-2 py-2.5 text-[1.4rem]'];

    /** Tapping a field pre-fills the command box with its keyword. */
    function edit(keyword: string) {
        commandOpen = true;
        command = keyword === '' ? '' : `${keyword} `;
        queueMicrotask(() => commandInput?.focus());
    }
</script>

{#snippet freeText(field: FreeTextField, label: string)}
    <label
        class={[
            cell,
            'min-w-0 items-stretch border-border text-[1.4rem] focus-within:border-accent'
        ]}
        data-field={field}
    >
        <input
            class="min-w-0 flex-1 rounded-none border-none bg-transparent p-0 text-lg placeholder:text-muted focus:outline-none"
            type="text"
            value={draft[field] ?? ''}
            onchange={(e) => app.setFreeText(field, e.currentTarget.value)}
            maxlength={FREE_TEXT_MAX_LENGTH}
            autocomplete="off"
            placeholder={label}
            aria-label={label}
        />
    </label>
{/snippet}

{#if problems.length > 0}
    <button class="mb-3 w-full border-accent bg-accent/20 text-left" onclick={onOpenSession}>
        {problems.join(' / ')} — tap to set up the session
    </button>
{/if}

<section class="mb-3 grid gap-2" aria-label="Draft QSO" bind:this={draftSection}>
    <div class="grid grid-cols-[2fr_1fr] gap-2">
        <button
            class={[
                cell,
                'flex-col items-center border-border py-1',
                draft.frequencyHz === undefined && 'text-muted'
            ]}
            data-field="frequency"
            onclick={() => edit('frequency')}
        >
            <span class="flex items-baseline gap-2">
                <span class="font-mono text-2xl font-semibold"
                    >{draft.frequencyHz === undefined
                        ? '---.---'
                        : formatMhz(draft.frequencyHz)}</span
                >
                <span class="text-sm text-muted">MHz</span>
            </span>
            <span class="text-xs text-muted">anchor {formatMhz(app.session.frequencyAnchorHz)}</span
            >
        </button>
        <button
            class={[button, 'border-border font-mono']}
            data-field="mode"
            onclick={() => edit('mode')}
        >
            {draft.mode ?? app.session.defaultMode}
        </button>
    </div>

    <div
        class={[cell, 'relative flex-col items-center gap-0.5 border-border py-2']}
        data-field="callsign"
    >
        <button
            class={[
                'h-[calc(var(--callsign-size)*1.2)] w-full overflow-hidden border-none bg-transparent p-0 font-mono leading-[1.2] font-bold whitespace-nowrap [--callsign-size:clamp(2.2rem,12vw,3.6rem)] after:absolute after:inset-0',
                draft.callsign
                    ? 'text-(length:--callsign-size) tracking-[0.04em]'
                    : 'text-[1.6rem] tracking-[0.2em] text-muted'
            ]}
            onclick={() => edit('')}
        >
            {draft.callsign ?? 'CALLSIGN'}
        </button>
        <div
            class={[
                'w-full truncate text-center text-xs tabular-nums',
                history?.status === 'error' ? 'text-error' : 'text-muted'
            ]}
            aria-label="Wavelog history"
            aria-live="polite"
        >
            {#if history?.status === 'error'}
                Wavelog lookup failed: {history.message}
            {:else}
                {found?.qsos ?? blank} QSOs · last {found ? date(found.last_qso) : blank} · QSL sent
                {found ? date(found.last_qsl_sent) : blank}
            {/if}
        </div>
    </div>

    <div class="grid grid-cols-2 gap-2">
        <button class={[button, 'border-border']} data-field="rstSent" onclick={() => edit('sent')}>
            <span class="text-sm text-muted">S</span><span class="font-mono text-3xl font-semibold"
                >{draft.rstSent}</span
            >
        </button>
        <button
            class={[button, 'border-border']}
            data-field="rstReceived"
            onclick={() => edit('received')}
        >
            <span class="text-sm text-muted">R</span><span class="font-mono text-3xl font-semibold"
                >{draft.rstReceived}</span
            >
        </button>
    </div>

    <div class="grid grid-cols-2 gap-2">
        {@render freeText('qth', 'QTH')}
        <button
            class={[button, 'border-border', !draft.jcx && 'text-muted']}
            data-field="jcx"
            onclick={() => edit('jcx')}
        >
            <span class="text-sm text-muted">JCC/JCG</span><span class="font-mono"
                >{draft.jcx ?? '—'}</span
            >
        </button>
    </div>

    <div class="grid grid-cols-2 gap-2">
        {@render freeText('name', 'Name')}
        <button
            class={[
                button,
                draft.qsl === 'none' ? 'border-border' : 'border-accent font-semibold text-accent'
            ]}
            data-field="qsl"
            onclick={() => edit('card')}
        >
            {{ none: 'No QSL', requested: 'Requested', oneWay: 'One Way' }[draft.qsl]}
        </button>
    </div>
</section>

<div
    class={[
        'pointer-events-none fixed top-2 left-1/2 z-10 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-control border-l-4 bg-surface-2 px-3.5 py-2.5 text-base shadow-[0_4px_16px_rgb(0_0_0/0.3)]',
        app.feedback === null
            ? '-translate-y-2 opacity-0'
            : 'translate-y-0 opacity-100 transition-[opacity,translate] duration-150',
        app.feedback?.kind === 'ok'
            ? 'border-ok'
            : app.feedback?.kind === 'error'
              ? 'border-error'
              : 'border-info'
    ]}
    role="status"
    aria-live="polite"
>
    {app.feedback?.message ?? ''}
</div>

{#if app.asr === 'ready'}
    <PttButton {app} />
{:else}
    <div
        class="grid min-h-36 place-content-center rounded-card border-2 border-dashed border-border p-4 text-center"
    >
        {#if app.asr === 'loading'}
            <p>Loading speech engine… (the first load downloads the model, ≈40 MB)</p>
        {:else}
            {#if app.asr === 'error'}
                <p class="my-3 text-error">Speech engine failed: {app.asrError}</p>
            {/if}
            <button class="px-5 py-3.5 text-lg" onclick={() => void app.loadAsr()}>
                Load speech engine (Vosk, ≈40 MB once)
            </button>
        {/if}
    </div>
{/if}

<div class="mt-3 grid grid-cols-[1fr_auto] gap-2">
    <button
        class="rounded-card border-none bg-log p-4 text-[1.4rem] font-bold tracking-wider text-white"
        onclick={() => void app.logQso()}
        disabled={app.ptt !== 'idle'}>LOG QSO</button
    >
    <button class="rounded-card" onclick={() => void app.clearDraft()}>Clear</button>
</div>

<details class="mt-3" bind:open={commandOpen}>
    <summary>Type a command</summary>
    <form onsubmit={submitCommand} class="grid grid-cols-[1fr_auto] gap-2">
        <input
            bind:this={commandInput}
            bind:value={command}
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="e.g. jl1his / received 57 / freq .94"
        />
        <button type="submit">Apply</button>
    </form>
</details>

{#if app.utterances.length > 0}
    <details class="mt-3">
        <summary>Recent utterances ({app.utterances.length})</summary>
        <ol class="m-0 grid list-none gap-1.5 p-0">
            {#each app.utterances as u (u.at + u.text)}
                <li
                    class={[
                        'grid border-l-3 px-2 py-1 text-sm',
                        u.ok ? 'border-ok' : 'border-error'
                    ]}
                >
                    <span class="font-mono" title={u.text}
                        >{u.source === 'typed' ? '⌨' : '🎙'} {u.heard}</span
                    >
                    <span class="hint">{u.message}</span>
                </li>
            {/each}
        </ol>
    </details>
{/if}
