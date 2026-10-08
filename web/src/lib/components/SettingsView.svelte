<script lang="ts">
    import { untrack } from 'svelte';
    import type { QsoApp } from '../app/app.svelte';
    import type { AppSettings } from '../app/settings';
    import AccountView from './AccountView.svelte';
    import StationsView from './StationsView.svelte';

    let { app }: { app: QsoApp } = $props();

    // Edit a copy; nothing changes until Save.
    let form = $state<AppSettings>(untrack(() => $state.snapshot(app.settings)));
    let saved = $state(false);

    async function save(e: SubmitEvent) {
        e.preventDefault();
        await app.saveSettings($state.snapshot(form));
        saved = true;
        setTimeout(() => (saved = false), 2000);
    }
</script>

<AccountView {app} />
{#if app.user !== null}
    <StationsView {app} />
{/if}

<form onsubmit={save}>
    <h2 class="mt-6 mb-3">Speech recognition</h2>
    <label class="field">
        <span>Vosk model</span>
        <select bind:value={form.voskLanguage}>
            <option value="en">English</option>
            <option value="ja">Japanese (Japanese pronunciation)</option>
        </select>
        <span class="hint">
            Hears the commands the way they are said in Japanese: <em>ゼロ ワン</em>,
            <em>ジュリエット リマ ワン</em>, and <em>送信</em>, <em>受信</em>, <em>周波数</em> for sent,
            received and frequency.
        </span>
    </label>
    <label class="field">
        <span>Release tail (ms)</span>
        <input type="number" min="0" max="2000" step="50" bind:value={form.releaseTailMs} />
        <span class="hint">Keeps listening briefly after the button is released.</span>
    </label>
    <label class="mb-3.5 flex items-center gap-2.5">
        <input class="size-5" type="checkbox" bind:checked={form.keepScreenOn} />
        Keep the screen on while operating
    </label>

    <button type="submit" class="btn-primary">{saved ? 'Saved ✓' : 'Save'}</button>
</form>

<section class="mt-5">
    <p>
        Speech engine: <strong>{app.asr}</strong>
        {#if app.asrError}<span class="text-error">({app.asrError})</span>{/if}
    </p>
    <button onclick={() => void app.loadAsr()} disabled={app.asr === 'loading'}
        >Reload speech engine</button
    >
</section>
