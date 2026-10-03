import { expect, test, type Page } from '@playwright/test';

async function setUpSession(page: Page) {
	await page.goto('./');
	await page.getByRole('button', { name: 'Session' }).click();
	await page.getByLabel('Operator callsign').fill('jj1abc');
	await page.getByLabel('Frequency anchor (MHz)').fill('433');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.locator('header')).toContainText('JJ1ABC');
}

async function type(page: Page, command: string) {
	const input = page.getByPlaceholder(/e\.g\. jl1his/);
	if (!(await input.isVisible())) await page.getByText('Type a command').click();
	await input.fill(command);
	await input.press('Enter');
}

test('fills a QSO from typed DSL commands and logs it locally', async ({ page }) => {
	await setUpSession(page);

	await type(page, 'juliett lima one hotel india sierra');
	await type(page, 'received five seven');
	await type(page, 'frequency point nine four');
	await type(page, 'jcx one zero zero one zero one');
	await type(page, 'card requested');

	const draft = page.getByLabel('Draft QSO');
	await expect(draft).toContainText('JL1HIS');
	await expect(draft).toContainText('57');
	await expect(draft).toContainText('432.940');
	await expect(draft).toContainText('100101');
	await expect(draft).toContainText('QSL Requested');

	await type(page, 'received banana');
	await expect(page.getByRole('status')).toContainText('unexpected "banana" in RST');

	await page.getByRole('button', { name: 'LOG QSO' }).click();
	await expect(page.getByRole('status')).toContainText('JL1HIS logged locally');
	// The next draft keeps the frequency but nothing QSO-specific.
	await expect(draft).toContainText('CALLSIGN');
	await expect(draft).toContainText('432.940');

	await page.reload();
	await page.getByRole('button', { name: /^Log/ }).click();
	await expect(page.locator('li', { hasText: 'JL1HIS' })).toContainText('432.940 FM · 59/57');

	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export ADIF' }).click();
	const file = await (await download).path();
	const adif = await (await import('node:fs/promises')).readFile(file, 'utf8');
	expect(adif).toContain('<CALL:6>JL1HIS');
	expect(adif).toContain('<QSL_SENT:1>R');
});

test('streams 16 kHz PCM from the microphone while PTT is held', async ({ page }) => {
	await setUpSession(page);

	// Replace the ASR with a fake that counts samples and "recognises" a fixed phrase.
	await page.evaluate(() => {
		const stats = { samples: 0, begins: 0 };
		(window as unknown as { __stats: typeof stats }).__stats = stats;
		const app = (window as unknown as { __qso: { useRecognizer(r: unknown): void } }).__qso;
		app.useRecognizer({
			name: 'fake',
			needsAudio: true,
			initialize: async () => {},
			beginUtterance: () => void stats.begins++,
			pushAudio: (s: Float32Array) => void (stats.samples += s.length),
			endUtterance: async () => ({ text: 'juliett romeo one alpha bravo charlie' }),
			cancelUtterance: () => {},
			dispose: () => {}
		});
	});

	const ptt = page.getByRole('button', { name: 'Push to talk' });
	const box = (await ptt.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

	// First press opens the microphone.
	await page.mouse.down();
	await expect(ptt).toContainText('LISTENING');
	await page.waitForTimeout(1000);
	await page.mouse.up();

	await expect(page.getByLabel('Draft QSO')).toContainText('JR1ABC');
	const stats = await page.evaluate(
		() => (window as unknown as { __stats: { samples: number; begins: number } }).__stats
	);
	expect(stats.begins).toBe(1);
	// ~1 s held + 300 ms release tail at 16 kHz.
	expect(stats.samples).toBeGreaterThan(16_000 * 1.0);
	expect(stats.samples).toBeLessThan(16_000 * 1.8);
});

test('starts offline once installed', async ({ page, context }) => {
	await page.goto('./');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await expect(page.getByRole('button', { name: 'LOG QSO' })).toBeVisible();

	await context.setOffline(true);
	await page.reload();
	await expect(page.getByRole('button', { name: 'LOG QSO' })).toBeVisible();
	await expect(page.locator('header')).toContainText('offline');
});
