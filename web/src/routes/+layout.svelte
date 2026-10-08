<script lang="ts">
    import '../app.css';
    import { asset } from '$app/paths';

    let { children } = $props();
</script>

<svelte:head>
    <link rel="icon" href={asset('icon.svg')} type="image/svg+xml" />
    <meta name="theme-color" content="#0d1117" />
    <link rel="manifest" href={asset('manifest.webmanifest')} />
    <link rel="apple-touch-icon" href={asset('icon-192.png')} />
</svelte:head>

{@render children()}
