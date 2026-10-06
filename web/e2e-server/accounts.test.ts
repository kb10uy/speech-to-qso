import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** Runs an admin command of the server against the test database. */
function admin(...args: string[]): string {
	return execFileSync(process.env.SERVER_BIN!, args, { encoding: 'utf8' });
}

/** A platform authenticator with discoverable credentials, as on a phone. */
async function addAuthenticator(page: Page) {
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
}

async function type(page: Page, command: string) {
	const input = page.getByPlaceholder(/e\.g\. jl1his/);
	if (!(await input.isVisible())) await page.getByText('Type a command').click();
	await input.fill(command);
	await input.press('Enter');
}

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
	await expect(page.getByTitle('Signed in')).toHaveText('JJ1ABC');
	expect(new URL(page.url()).hash).toBe('');

	// A station entered by hand becomes the default and fills in the session.
	await page.getByRole('button', { name: '⚙' }).click();
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
	await expect(page.getByLabel('Operating location')).toHaveValue('Minato');
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
	expect(adif).toContain('<MY_POTA_REF:7>JP-0001');

	// Signing in again needs no callsign: the passkey identifies the user.
	await page.getByRole('button', { name: '⚙' }).click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
	await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
	await expect(page.getByTitle('Signed in')).toHaveText('JJ1ABC');

	// The link only registers the first passkey.
	await page.goto(link);
	await expect(page.getByRole('alert')).toContainText('already has a passkey');
});
