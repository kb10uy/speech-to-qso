<script lang="ts">
    import { untrack } from 'svelte';
    import type { QsoApp } from '../app/app.svelte';
    import { FREE_TEXT_MAX_LENGTH, formatMhz, formatUtcMinute, sessionProblems } from '../qso';
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

    function time(iso: string | null): string {
        return iso === null ? '—' : formatUtcMinute(iso);
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

    /** Tapping a field pre-fills the command box with its keyword. */
    function edit(keyword: string) {
        commandOpen = true;
        command = keyword === '' ? '' : `${keyword} `;
        queueMicrotask(() => commandInput?.focus());
    }
</script>

{#if problems.length > 0}
    <button class="banner" onclick={onOpenSession}>
        {problems.join(' / ')} — tap to set up the session
    </button>
{/if}

<section class="draft" aria-label="Draft QSO" bind:this={draftSection}>
    <div class="row">
        <button
            class="cell freq"
            data-field="frequency"
            class:empty={draft.frequencyHz === undefined}
            onclick={() => edit('frequency')}
        >
            <span class="mono"
                >{draft.frequencyHz === undefined ? '---.---' : formatMhz(draft.frequencyHz)}</span
            >
            <span class="unit">MHz</span>
        </button>
        <button class="cell mode mono" data-field="mode" onclick={() => edit('mode')}>
            {draft.mode ?? app.session.defaultMode}
        </button>
    </div>

    <button
        class="cell callsign mono"
        data-field="callsign"
        class:empty={!draft.callsign}
        onclick={() => edit('')}
    >
        {draft.callsign ?? 'CALLSIGN'}
    </button>

    <div class="row">
        <button class="cell rst" data-field="rstSent" onclick={() => edit('sent')}>
            <span class="key">S</span><span class="mono">{draft.rstSent}</span>
        </button>
        <button class="cell rst" data-field="rstReceived" onclick={() => edit('received')}>
            <span class="key">R</span><span class="mono">{draft.rstReceived}</span>
        </button>
    </div>

    <div
        class="history {history?.status ?? 'none'}"
        aria-label="Wavelog history"
        aria-live="polite"
    >
        {#if history?.status === 'error'}
            <span class="note">Wavelog lookup failed: {history.message}</span>
        {:else}
            <div><span class="key">QSOs</span><span class="mono">{found?.qsos ?? blank}</span></div>
            <div>
                <span class="key">Last QSO</span>
                <span class="mono">{found ? time(found.last_qso) : blank}</span>
            </div>
            <div>
                <span class="key">Last QSL sent</span>
                <span class="mono">{found ? time(found.last_qsl_sent) : blank}</span>
            </div>
        {/if}
    </div>

    <div class="row">
        <button class="cell" data-field="jcx" class:empty={!draft.jcx} onclick={() => edit('jcx')}>
            <span class="key">JCC/JCG</span><span class="mono">{draft.jcx ?? '—'}</span>
        </button>
        <button
            class="cell"
            data-field="qsl"
            class:qsl={draft.qsl !== 'none'}
            onclick={() => edit('card')}
        >
            {{ none: 'No QSL', requested: 'QSL Requested', oneWay: 'QSL One Way' }[draft.qsl]}
        </button>
    </div>

    <div class="row">
        {#each [['name', 'Name'], ['qth', 'QTH']] as const as [field, label] (field)}
            <label class="cell text" data-field={field}>
                <input
                    type="text"
                    value={draft[field] ?? ''}
                    onchange={(e) => app.setFreeText(field, e.currentTarget.value)}
                    maxlength={FREE_TEXT_MAX_LENGTH}
                    autocomplete="off"
                    placeholder={label}
                    aria-label={label}
                />
            </label>
        {/each}
    </div>

    <div class="meta">
        <span>anchor {formatMhz(app.session.frequencyAnchorHz)} MHz</span>
    </div>
</section>

<div
    class="toast {app.feedback?.kind ?? ''}"
    class:shown={app.feedback !== null}
    role="status"
    aria-live="polite"
>
    {app.feedback?.message ?? ''}
</div>

{#if app.asr === 'ready'}
    <PttButton {app} />
{:else}
    <div class="asr">
        {#if app.asr === 'loading'}
            <p>Loading speech engine… (the first load downloads the model, ≈40 MB)</p>
        {:else}
            {#if app.asr === 'error'}
                <p class="error">Speech engine failed: {app.asrError}</p>
            {/if}
            <button class="load" onclick={() => void app.loadAsr()}>
                Load speech engine (Vosk, ≈40 MB once)
            </button>
        {/if}
    </div>
{/if}

<div class="actions">
    <button class="log" onclick={() => void app.logQso()} disabled={app.ptt !== 'idle'}
        >LOG QSO</button
    >
    <button class="clear" onclick={() => void app.clearDraft()}>Clear</button>
</div>

<details bind:open={commandOpen}>
    <summary>Type a command</summary>
    <form onsubmit={submitCommand} class="command">
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
    <details>
        <summary>Recent utterances ({app.utterances.length})</summary>
        <ol class="utterances">
            {#each app.utterances as u (u.at + u.text)}
                <li class:bad={!u.ok}>
                    <span class="mono" title={u.text}
                        >{u.source === 'typed' ? '⌨' : '🎙'} {u.heard}</span
                    >
                    <span class="hint">{u.message}</span>
                </li>
            {/each}
        </ol>
    </details>
{/if}

<style>
    .banner {
        width: 100%;
        margin-bottom: 0.8rem;
        background: color-mix(in srgb, var(--accent) 20%, transparent);
        border-color: var(--accent);
        text-align: left;
    }
    .draft {
        display: grid;
        gap: 0.5rem;
        margin-bottom: 0.8rem;
    }
    .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.5rem;
    }
    .cell {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 0.6rem 0.8rem;
        font-size: 1.4rem;
        display: flex;
        align-items: baseline;
        justify-content: center;
        gap: 0.5rem;
        min-height: 3.4rem;
    }
    .cell.empty {
        color: var(--muted);
    }
    .cell.text {
        align-items: stretch;
        min-width: 0;
        padding-block: 0;
    }
    .cell.text input {
        flex: 1;
        min-width: 0;
        border: none;
        border-radius: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 1.1rem;
        padding: 0;
    }
    .cell.text input::placeholder {
        color: var(--muted);
    }
    .cell.text input:focus {
        outline: none;
    }
    .cell.text:focus-within {
        border-color: var(--accent);
    }
    .callsign {
        --callsign-size: clamp(2.2rem, 12vw, 3.6rem);
        font-size: var(--callsign-size);
        font-weight: 700;
        letter-spacing: 0.04em;
        padding: 0.8rem;
        box-sizing: border-box;
        height: calc(var(--callsign-size) * 1.2 + 1.6rem + 2px);
        line-height: 1.2;
        align-items: center;
        white-space: nowrap;
        overflow: hidden;
    }
    .callsign.empty {
        font-size: 1.6rem;
        letter-spacing: 0.2em;
    }
    .key {
        font-size: 0.9rem;
        color: var(--muted);
    }
    .rst .mono {
        font-size: 1.8rem;
        font-weight: 600;
    }
    .freq .mono {
        font-size: 1.6rem;
        font-weight: 600;
    }
    .unit {
        font-size: 0.9rem;
        color: var(--muted);
    }
    .row:has(.freq) {
        grid-template-columns: 2fr 1fr;
    }
    .history {
        display: grid;
        grid-template-columns: auto 1fr 1fr;
        gap: 0.8rem;
        align-items: start;
        min-height: 3.6rem;
        box-sizing: border-box;
        padding: 0.3rem 0.8rem;
        border-left: 4px solid var(--info);
        border-radius: var(--radius);
        background: var(--surface);
    }
    .history > div {
        display: grid;
    }
    .history .key {
        font-size: 0.75rem;
    }
    .history .mono {
        font-size: 0.95rem;
        line-height: 1.2;
    }
    .history .note {
        grid-column: 1 / -1;
        align-self: center;
        font-size: 0.9rem;
        color: var(--muted);
    }
    .history.error {
        border-left-color: var(--error);
    }
    .history.error .note {
        color: var(--error);
    }
    .qsl {
        color: var(--accent);
        border-color: var(--accent);
        font-weight: 600;
    }
    .meta {
        display: flex;
        justify-content: space-between;
        font-size: 0.8rem;
        color: var(--muted);
        padding: 0 0.3rem;
    }
    .toast {
        position: fixed;
        top: 0.5rem;
        left: 50%;
        z-index: 10;
        width: max-content;
        max-width: calc(100vw - 2rem);
        padding: 0.6rem 0.9rem;
        border-radius: 10px;
        border-left: 4px solid var(--info);
        background: var(--surface-2);
        box-shadow: 0 4px 16px rgb(0 0 0 / 0.3);
        font-size: 0.95rem;
        pointer-events: none;
        opacity: 0;
        transform: translate(-50%, -0.5rem);
    }
    .toast.shown {
        opacity: 1;
        transform: translate(-50%, 0);
        transition:
            opacity 150ms,
            transform 150ms;
    }
    .toast.ok {
        border-left-color: var(--ok);
    }
    .toast.error {
        border-left-color: var(--error);
    }
    .asr {
        min-height: 9rem;
        display: grid;
        place-content: center;
        text-align: center;
        border: 2px dashed var(--border);
        border-radius: 22px;
        padding: 1rem;
    }
    .asr .error {
        color: var(--error);
    }
    .load {
        font-size: 1.1rem;
        padding: 0.9rem 1.2rem;
    }
    .actions {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.5rem;
        margin-top: 0.8rem;
    }
    .log {
        background: var(--log);
        color: #fff;
        border: none;
        font-size: 1.4rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        padding: 1rem;
        border-radius: 16px;
    }
    .clear {
        border-radius: 16px;
    }
    details {
        margin-top: 0.8rem;
    }
    .command {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.5rem;
    }
    .utterances {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 0.4rem;
    }
    .utterances li {
        display: grid;
        font-size: 0.85rem;
        padding: 0.3rem 0.5rem;
        border-left: 3px solid var(--ok);
    }
    .utterances li.bad {
        border-left-color: var(--error);
    }
</style>
