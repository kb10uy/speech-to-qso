import { expect, test, type Page } from '@playwright/test';

const audio = Buffer.from('RIFF0000WAVEtest');
const file = { name: 'sample.wav', mimeType: 'audio/wav', buffer: audio };

async function mockTranscription(page: Page, text = 'received five seven') {
	const uploads: Buffer[] = [];
	await page.route('**/api/transcribe', async (route) => {
		uploads.push(route.request().postDataBuffer()!);
		await route.fulfill({
			json: { text, model: 'gpt-transcribe', elapsed_ms: 850, request_id: 'req_mock' }
		});
	});
	return uploads;
}

test('uploads the same audio with different hints and keeps raw transcripts for comparison', async ({
	page
}, testInfo) => {
	const uploads = await mockTranscription(page, '<script>alert(1)</script> JCX 01008.');
	await page.goto('/');
	await expect(page.getByText('Server connected')).toBeVisible();
	await page.locator('#audio-file').setInputFiles(file);
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.locator('.transcript')).toHaveText('<script>alert(1)</script> JCX 01008.');
	await expect(page.locator('.result-timing')).toHaveText('0.85 s');
	await page.getByLabel('Prompt').fill('Radio command');
	await page.getByLabel('Keywords').fill('JCX\nQSL');
	await page.getByLabel('Languages').fill('en, ja');
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.locator('.result')).toHaveCount(2);
	expect(uploads[0].includes(audio)).toBe(true);
	expect(uploads[1].includes(audio)).toBe(true);
	expect(uploads[0].toString()).not.toContain('name="prompt"');
	expect(uploads[1].toString()).toContain('Radio command');
	expect(uploads[1].toString().match(/name="keywords\[\]"/g)).toHaveLength(2);
	expect(uploads[1].toString().match(/name="languages\[\]"/g)).toHaveLength(2);
	await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
	await page.getByRole('button', { name: 'Clear history' }).click();
	await expect(page.locator('.result')).toHaveCount(0);
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await expect(page.getByLabel('Prompt')).toHaveValue('');
	await expect(page.getByLabel('Languages')).toHaveValue('en');
});

test('PTT uses 16 kHz mono WAV and only sends after release', async ({ page }) => {
	const uploads = await mockTranscription(page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Enable microphone' }).click();
	const ptt = page.getByRole('button', { name: 'Hold to talk', exact: true });
	await expect(ptt).toBeEnabled();
	const position = await ptt.boundingBox();
	await page.mouse.move(position!.x + 50, position!.y + 50);
	await page.mouse.down();
	await expect(ptt).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('#duration')).not.toHaveText('00.0 s');
	expect(uploads).toHaveLength(0);
	await page.mouse.up();
	await expect(page.locator('.result')).toHaveCount(1);
	await expect(page.locator('#recording')).toBeVisible();
	const start = uploads[0].indexOf('RIFF');
	expect(start).toBeGreaterThan(0);
	const wav = uploads[0].subarray(start);
	expect(wav.subarray(8, 12).toString()).toBe('WAVE');
	expect(wav.readUInt16LE(22)).toBe(1);
	expect(wav.readUInt32LE(24)).toBe(16_000);
	expect(wav.readUInt16LE(34)).toBe(16);
	expect(wav.readUInt32LE(40)).toBeGreaterThan(0);
	await page.getByRole('button', { name: 'Disable microphone' }).click();
	await expect(ptt).toBeDisabled();
});

test('keyboard PTT cancels on lost focus and can record again', async ({ page }) => {
	const uploads = await mockTranscription(page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Enable microphone' }).click();
	const ptt = page.getByRole('button', { name: 'Hold to talk', exact: true });
	await expect(ptt).toBeEnabled();
	await ptt.focus();
	await page.keyboard.down('Space');
	await expect(ptt).toHaveAttribute('aria-pressed', 'true');
	await page.locator('h1').evaluate((element) => {
		element.tabIndex = 0;
		element.focus();
	});
	await page.keyboard.up('Space');
	await expect(ptt).toHaveAttribute('aria-pressed', 'false');
	expect(uploads).toHaveLength(0);
	await ptt.focus();
	await page.keyboard.down('Space');
	await expect(page.locator('#duration')).not.toHaveText('00.0 s');
	await page.keyboard.up('Space');
	await expect(page.locator('.result')).toHaveCount(1);
});

test('shows upstream failures and preserves audio for retry', async ({ page }) => {
	await page.route('**/api/transcribe', (route) =>
		route.fulfill({
			status: 502,
			json: {
				error: 'OpenAI rejected transcription',
				upstream_status: 401,
				request_id: 'req_failed'
			}
		})
	);
	await page.goto('/');
	await page.locator('#audio-file').setInputFiles(file);
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.getByRole('alert')).toContainText('upstream HTTP 401');
	await expect(page.getByRole('alert')).toContainText('req_failed');
	await expect(page.getByRole('button', { name: 'Transcribe audio' })).toBeEnabled();
	await mockTranscription(page);
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.locator('.result')).toHaveCount(1);
	await expect(page.getByRole('alert')).toBeHidden();
});

test('mobile page fits the viewport and starts with safe defaults', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Transcription lab.' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Hold to talk', exact: true })).toBeDisabled();
	await expect(page.getByLabel('Prompt')).toHaveValue('');
	await expect(page.getByLabel('Keywords')).toHaveValue('');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
	await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
});
