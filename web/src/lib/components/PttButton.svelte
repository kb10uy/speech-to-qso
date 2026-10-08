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
    class={[
        'relative grid min-h-36 w-full touch-none place-content-center gap-1.5 overflow-hidden rounded-3xl border-none text-2xl font-bold tracking-wider transition-[background-color,scale] duration-80 select-none [-webkit-touch-callout:none]',
        app.ptt === 'listening' || app.ptt === 'opening'
            ? 'scale-98 bg-ptt-active text-white'
            : app.ptt === 'finishing'
              ? 'bg-surface-2 text-text'
              : 'bg-ptt text-white'
    ]}
    onpointerdown={down}
    onpointerup={() => void app.pttRelease()}
    onpointercancel={() => void app.pttCancel()}
    oncontextmenu={(e) => e.preventDefault()}
    aria-label="Push to talk"
>
    <span
        class="absolute bottom-0 left-0 h-2 w-full origin-left bg-white/85 transition-transform duration-60 ease-linear"
        style:transform="scaleX({app.ptt === 'listening' ? meter : 0})"
    ></span>
    <span class="relative">{label}</span>
    {#if app.ptt === 'listening' && app.partial}
        <span class="relative px-4 text-base font-normal tracking-normal opacity-90"
            >{app.partial}</span
        >
    {/if}
</button>
