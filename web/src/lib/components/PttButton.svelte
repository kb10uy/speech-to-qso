<script lang="ts">
    import type { QsoApp } from '../app/app.svelte';
    import { flash } from './flash';

    let { app }: { app: QsoApp } = $props();

    let button = $state<HTMLButtonElement | null>(null);

    $effect(() =>
        app.onUtterance(({ source, ok }) => {
            if (!ok && source === 'voice') void flash(() => button, 'flash-error');
        })
    );

    function down(e: PointerEvent) {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        void app.pttPress();
    }

    const label = $derived(
        {
            idle: 'HOLD TO TALK',
            opening: 'OPENING MIC…',
            listening: 'LISTENING',
            finishing: 'RECOGNIZING…'
        }[app.ptt]
    );
    // Perceptual-ish scaling of the RMS level for the meter.
    const meter = $derived(Math.min(1, Math.sqrt(app.level) * 2.5));
</script>

<button
    bind:this={button}
    class="ptt"
    class:active={app.ptt === 'listening' || app.ptt === 'opening'}
    class:busy={app.ptt === 'finishing'}
    onpointerdown={down}
    onpointerup={() => void app.pttRelease()}
    onpointercancel={() => void app.pttCancel()}
    oncontextmenu={(e) => e.preventDefault()}
    aria-label="Push to talk"
>
    <span class="meter" style:transform="scaleX({app.ptt === 'listening' ? meter : 0})"></span>
    <span class="label">{label}</span>
    {#if app.ptt === 'listening' && app.partial}
        <span class="partial">{app.partial}</span>
    {/if}
</button>

<style>
    .ptt {
        position: relative;
        overflow: hidden;
        width: 100%;
        min-height: 9rem;
        border-radius: 22px;
        border: none;
        background: var(--ptt);
        color: #fff;
        display: grid;
        place-content: center;
        gap: 0.4rem;
        font-size: 1.6rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        touch-action: none;
        transition:
            background 80ms,
            transform 80ms;
    }
    .ptt.active {
        background: var(--ptt-active);
        transform: scale(0.98);
    }
    .ptt.busy {
        background: var(--surface-2);
        color: var(--text);
    }
    .meter {
        position: absolute;
        left: 0;
        bottom: 0;
        height: 8px;
        width: 100%;
        background: rgba(255, 255, 255, 0.85);
        transform-origin: left;
        transition: transform 60ms linear;
    }
    .label,
    .partial {
        position: relative;
    }
    .partial {
        font-size: 0.95rem;
        font-weight: 400;
        letter-spacing: 0;
        opacity: 0.9;
        padding: 0 1rem;
    }
</style>
