import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	webServer: {
		// The app alone, without the server: everything but syncing works locally.
		command: `npm run build && npx vite preview --port 4173 --strictPort`,
		port: 4173,
		reuseExistingServer: !process.env.CI
	},
	use: {
		baseURL: 'http://localhost:4173/',
		permissions: ['microphone'],
		launchOptions: {
			args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
		}
	}
});
