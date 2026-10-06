import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 4174;

// The built app served by the real server, with a fresh database for every run. The tests run
// the server's admin commands against the same database (workers inherit the environment).
process.env.SERVER_BIN ??= resolve(
	`../server/target/debug/speech-to-qso-server${process.platform === 'win32' ? '.exe' : ''}`
);
process.env.DATABASE_PATH ??= join(mkdtempSync(join(tmpdir(), 'speech-to-qso-')), 'test.db');
// Passkeys are bound to the origin, so the app must be opened at exactly this URL.
process.env.PUBLIC_ORIGIN ??= `http://localhost:${PORT}`;

export default defineConfig({
	testDir: 'e2e-server',
	workers: 1,
	webServer: {
		command: 'npm run build && cargo run --manifest-path ../server/Cargo.toml -- serve',
		env: { LISTEN: `127.0.0.1:${PORT}`, WEB_DIR: 'build' },
		url: `${process.env.PUBLIC_ORIGIN}/api/health`,
		timeout: 600_000,
		reuseExistingServer: false
	},
	use: {
		baseURL: `${process.env.PUBLIC_ORIGIN}/`,
		permissions: ['microphone'],
		launchOptions: {
			args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
		}
	}
});
