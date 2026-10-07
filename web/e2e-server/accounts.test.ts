import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { QsoApp } from '../src/lib/app/app.svelte';

declare global {
	interface Window {
		__qso: QsoApp;
	}
}

/** Runs an admin command of the server against the test database. */
function admin(...args: string[]): string {
	return execFileSync(process.env.SERVER_BIN!, args, { encoding: 'utf8' });
}

/** A platform authenticator with discoverable credentials, as on a phone. */
const authenticators = new WeakSet<Page>();
async function addAuthenticator(page: Page) {
	if (authenticators.has(page)) return;
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	authenticators.add(page);
}

async function type(page: Page, command: string) {
	const input = page.getByPlaceholder(/e\.g\. jl1his/);
	if (!(await input.isVisible())) await page.getByText('Type a command').click();
	await input.fill(command);
	await input.press('Enter');
}

async function registerUser(page: Page, callsign: string) {
	admin('user', 'create', callsign);
	const link = admin('passkey', 'bootstrap', callsign).match(/^http\S+#bootstrap=\S+$/m)![0];
	await addAuthenticator(page);
	await page.goto(link);
	await expect(page.getByLabel('Set up a passkey')).toContainText(callsign);
	await page.getByRole('button', { name: 'Create passkey' }).click();
	await expect(page.getByRole('button', { name: callsign, exact: true })).toBeVisible();
	await page.waitForFunction(() => window.__qso.ready && !window.__qso.syncing);
}

test('keeps local and account logs separate, rejects a changed cookie and clears a deleted station', async ({
	page,
	context
}) => {
	await page.goto('./');
	await page.waitForFunction(() => window.__qso?.ready && window.__qso.account === 'signedOut');
	await type(page, 'jl1his freq 432.94');
	await page.getByRole('button', { name: 'LOG QSO' }).click();
	await registerUser(page, 'JJ2AAA');
	expect(await page.evaluate(() => window.__qso.log.length)).toBe(0);
	expect(await page.evaluate(() => window.__qso.localQsoCount)).toBe(1);

	await page.getByRole('button', { name: /^Log/ }).click();
	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Import local QSOs' }).click();
	await expect(page.locator('li', { hasText: 'JL1HIS' })).toContainText('synced');
	// Keep another valid A session: signing out revokes the current cookie's token.
	const originalCookieA = await context.cookies();
	await page.evaluate(() => window.__qso.api.signIn());
	const cookieA = await context.cookies();
	await context.addCookies(originalCookieA);
	await page.route('**/api/qso', (route) =>
		route.fulfill({ status: 502, json: { error: 'offline' } })
	);
	await page.evaluate(async () => {
		const app = window.__qso;
		await app.saveSession({ ...app.session, operatorCall: 'JJ2AAA', location: 'A location' });
		app.handleText('ja1abc freq 432.94', 'typed');
		await app.logQso();
	});
	await page.waitForFunction(() => !window.__qso.syncing && window.__qso.unsyncedCount === 1);
	await page.evaluate(() => window.__qso.signOut());
	await page.unroute('**/api/qso');
	await registerUser(page, 'JJ2BBB');
	expect(await page.evaluate(() => window.__qso.log.length)).toBe(0);
	expect(await page.evaluate(() => window.__qso.session.location)).toBe('');
	expect(await page.evaluate(async () => await (await fetch('/api/qso.adi')).text())).not.toContain(
		'<EOR>'
	);

	await context.addCookies(cookieA);
	await page.evaluate(() => window.__qso.refreshAccount());
	await page.waitForFunction(() => !window.__qso.syncing);
	expect(await page.evaluate(() => window.__qso.user?.callsign)).toBe('JJ2AAA');
	expect(await page.evaluate(() => window.__qso.session.location)).toBe('A location');
	expect(await page.evaluate(() => window.__qso.log.length)).toBe(2);

	const other = await context.newPage();
	await registerUser(other, 'JJ2CCC');
	// This tab still remembers A, while its shared cookie now belongs to C.
	expect(await page.evaluate(() => window.__qso.user?.callsign)).toBe('JJ2AAA');
	await page.evaluate(async () => {
		window.__qso.handleText('ja1xyz freq 432.94', 'typed');
		await window.__qso.logQso();
	});
	await page.waitForFunction(
		() => window.__qso.user?.callsign === 'JJ2CCC' && !window.__qso.syncing
	);
	expect(await page.evaluate(() => window.__qso.log.length)).toBe(0);
	expect(await page.evaluate(async () => await (await fetch('/api/qso.adi')).text())).not.toContain(
		'<EOR>'
	);
	await other.close();
	await context.addCookies(cookieA);
	await page.evaluate(() => window.__qso.refreshAccount());
	await page.waitForFunction(() => !window.__qso.syncing);
	expect(await page.evaluate(() => window.__qso.log.length)).toBe(3);
	expect(await page.evaluate(() => window.__qso.unsyncedCount)).toBe(0);

	await page.evaluate(async () => {
		const app = window.__qso;
		const station = await app.api.createStation({ name: 'Park', callsign: 'JJ2AAA' } as Parameters<
			typeof app.api.createStation
		>[0]);
		await app.loadStations();
		await app.api.deleteStation(station.id);
		await app.loadStations();
	});
	expect(await page.evaluate(() => window.__qso.session.stationId)).toBeUndefined();
	await page.evaluate(async () => {
		window.__qso.handleText('ja1def freq 432.94', 'typed');
		await window.__qso.logQso();
	});
	await page.waitForFunction(() => !window.__qso.syncing);
	expect(await page.evaluate(() => window.__qso.unsyncedCount)).toBe(0);
});

test('shows what Wavelog knows about the callsign above JCC/JCG', async ({ page }) => {
	await registerUser(page, 'JJ4AAA');
	const history = page.getByLabel('Wavelog history');

	const unconfigured = page.waitForResponse('**/api/wavelog/history?**');
	await type(page, 'jl1his');
	expect((await unconfigured).status()).toBe(409);
	await expect(history).toContainText(/QSOs\s*—/);

	await page.route('**/api/wavelog/history?**', (route) => {
		const callsign = new URL(route.request().url()).searchParams.get('callsign');
		const qsos = callsign === 'JA1ABC' ? 3 : 0;
		return route.fulfill({
			json: {
				callsign,
				qsos,
				last_qso: qsos > 0 ? '2026-10-03T04:05:06Z' : null,
				last_qsl_sent: qsos > 0 ? '2025-04-01T12:34:56Z' : null
			}
		});
	});
	await type(page, 'ja1abc');
	await expect(history).toContainText(/QSOs\s*3/);
	await expect(history).toContainText('2026-10-03 04:05Z');
	await expect(history).toContainText('2025-04-01 12:34Z');
	await expect(history.locator('xpath=following-sibling::*[1]')).toContainText('JCC/JCG');

	await type(page, 'jr1zzz');
	await expect(history).toContainText(/QSOs\s*0/);
	await expect(history).not.toContainText('2026');
	await page.getByRole('button', { name: 'Clear' }).click();
	await expect(history).toContainText(/QSOs\s*—/);
});

test('allows only one concurrent completion of a bootstrap link', async ({ page }) => {
	admin('user', 'create', 'JJ3AAA');
	const link = admin('passkey', 'bootstrap', 'JJ3AAA').match(/^http\S+#bootstrap=\S+$/m)![0];
	const token = new URL(link).hash.slice('#bootstrap='.length);
	await addAuthenticator(page);
	await page.goto('./');
	await page.waitForFunction(() => window.__qso?.ready);
	const results = await page.evaluate(async (token) => {
		const registrations = [];
		for (let i = 0; i < 8; i++) {
			const started = await window.__qso.api.startBootstrap(token);
			const options = JSON.parse(
				JSON.stringify(started.options, (_, v) => (v === null ? undefined : v))
			);
			const credential = (await navigator.credentials.create({
				publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options.publicKey)
			})) as PublicKeyCredential;
			registrations.push({
				ceremony: started.ceremony,
				credential: credential.toJSON(),
				name: `Key ${i}`
			});
		}
		return Promise.all(
			registrations.map(async (body) => {
				const response = await fetch('/api/auth/bootstrap/finish', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				});
				return response.status;
			})
		);
	}, token);
	expect(results.filter((status) => status === 200)).toHaveLength(1);
	expect(results.filter((status) => status === 403)).toHaveLength(7);
	expect(await page.evaluate(async () => (await window.__qso.api.passkeys()).length)).toBe(1);
});

test('registers a passkey from a bootstrap link, logs and syncs a QSO, signs in again', async ({
	page
}) => {
	admin('user', 'create', 'jj1abc');
	const link = admin('passkey', 'bootstrap', 'JJ1ABC').match(/^http\S+#bootstrap=\S+$/m)![0];
	await addAuthenticator(page);

	await page.goto(link);
	await expect(page.getByLabel('Set up a passkey')).toContainText('JJ1ABC');
	await page.getByLabel('Passkey name').fill('Test phone');
	await page.getByRole('button', { name: 'Create passkey' }).click();
	await expect(page.getByRole('button', { name: 'JJ1ABC' })).toBeVisible();
	expect(new URL(page.url()).hash).toBe('');

	// A station entered by hand becomes the default and fills in the session.
	await page.getByRole('button', { name: 'JJ1ABC' }).click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	await expect(page.getByLabel('Account')).toContainText('Test phone');
	await page.getByRole('button', { name: 'Add a station' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Park');
	await page.getByLabel('Station callsign').fill('jj1abc/1');
	await page.getByLabel('Location (city)').fill('Minato');
	await page.getByLabel('POTA reference').fill('jp-0001');
	await page.getByRole('button', { name: 'Save station' }).click();
	await expect(page.getByLabel('Default station')).toHaveValue(/.+/);
	await expect(page.getByLabel('Stations')).toContainText('Park · JJ1ABC/1');

	await page.getByRole('button', { name: 'Session', exact: true }).click();
	await expect(page.getByRole('combobox', { name: /^Station/ })).toHaveValue(/.+/);
	// The station's values are only shown; empty fields are left to the station.
	await expect(page.getByLabel('Operating location')).toHaveValue('');
	await expect(page.getByLabel('Operating location')).toHaveAttribute('placeholder', 'Minato');
	// Left to Wavelog unless entered.
	await expect(page.getByLabel('Operator callsign')).toHaveValue('');
	await page.getByLabel('Frequency anchor (MHz)').fill('433');
	await page.getByRole('button', { name: 'Save' }).click();

	await type(page, 'juliett lima one hotel india sierra received five seven');
	await type(page, 'frequency point nine four');
	await page.getByRole('button', { name: 'LOG QSO' }).click();
	await page.getByRole('button', { name: /^Log/ }).click();
	await expect(page.locator('li', { hasText: 'JL1HIS' })).toContainText('synced');

	const download = page.waitForEvent('download');
	await page.getByRole('link', { name: 'Download the server log' }).click();
	const adif = await readFile(await (await download).path(), 'utf8');
	expect(adif).toContain('<CALL:6>JL1HIS');
	expect(adif).toContain('<STATION_CALLSIGN:8>JJ1ABC/1');
	expect(adif).not.toContain('<OPERATOR:');
	expect(adif).toContain('<MY_CITY:6>Minato');
	expect(adif).toContain('<MY_POTA_REF:7>JP-0001');

	// Signing in again needs no callsign: the passkey identifies the user.
	await page.getByRole('button', { name: 'JJ1ABC' }).click();
	await page.getByRole('menuitem', { name: 'Sign out' }).click();
	// The operator is left to Wavelog, so nothing names the user any more.
	await page.getByRole('button', { name: 'Menu' }).click();
	await page.getByRole('menuitem', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'JJ1ABC' })).toBeVisible();

	// The link is used up once it has registered the first passkey.
	await page.goto(link);
	await expect(page.getByRole('alert')).toContainText('invalid or has expired');
});
