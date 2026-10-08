import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

// The server (see server/) serves the built app and its API on one origin. In development,
// Vite forwards the API to it; run it with PUBLIC_ORIGIN=http://localhost:5173.
const apiServer = process.env.API_SERVER ?? 'http://127.0.0.1:8080';

export default defineConfig({
    plugins: [
        sveltekit({
            compilerOptions: {
                // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
                runes: ({ filename }) =>
                    filename.split(/[/\\]/).includes('node_modules') ? undefined : true
            },
            adapter: adapter()
        })
    ],
    server: {
        proxy: { '/api': apiServer }
    },
    build: {
        // vosk-browser bundles the WASM recogniser into one lazily loaded chunk.
        chunkSizeWarningLimit: 6000
    },
    test: {
        expect: { requireAssertions: true },
        projects: [
            {
                extends: './vite.config.ts',
                build: {
                    // vosk-browser bundles the WASM recogniser into one lazily loaded chunk.
                    chunkSizeWarningLimit: 6000
                },
                test: {
                    name: 'unit',
                    environment: 'node',
                    include: ['src/**/*.{test,spec}.{js,ts}'],
                    exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
                }
            }
        ]
    }
});
