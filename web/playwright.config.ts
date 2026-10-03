import { defineConfig } from '@playwright/test';

const BASE_PATH = '/speech-to-qso';

export default defineConfig({
	testDir: 'e2e',
	webServer: {
		command: `npm run build && npx vite preview --port 4173 --strictPort`,
		env: { BASE_PATH },
		port: 4173,
		reuseExistingServer: !process.env.CI
	},
	use: {
		baseURL: `http://localhost:4173${BASE_PATH}/`,
		permissions: ['microphone'],
		launchOptions: {
			args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
		}
	}
});
