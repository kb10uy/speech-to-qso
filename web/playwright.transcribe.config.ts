import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e-transcribe',
	webServer: {
		command: 'cargo run --manifest-path ../transcribe-server/Cargo.toml',
		env: {
			OPENAI_API_KEY: 'test-key',
			LISTEN: '127.0.0.1:8082',
			OPENAI_TRANSCRIBE_MODEL: 'gpt-transcribe'
		},
		url: 'http://127.0.0.1:8082/api/health',
		timeout: 180_000,
		reuseExistingServer: false
	},
	use: {
		baseURL: 'http://127.0.0.1:8082',
		permissions: ['microphone'],
		launchOptions: {
			channel: process.env.PLAYWRIGHT_CHANNEL,
			args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
		}
	}
});
