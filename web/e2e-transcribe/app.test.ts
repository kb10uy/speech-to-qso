import { expect, test, type Page } from '@playwright/test';

const audio = Buffer.from('RIFF0000WAVEtest');
const file = { name: 'sample.wav', mimeType: 'audio/wav', buffer: audio };
const defaultPrompt =
	'English amateur radio QSO logging command. Callsigns and codes are spoken as letters, NATO phonetic words and digits.';
const defaultKeywords = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('\n');

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
	expect(uploads[0].toString()).toContain(defaultPrompt);
	expect(uploads[0].toString().match(/name="keywords\[\]"/g)).toHaveLength(36);
	expect(uploads[1].toString()).not.toContain(defaultPrompt);
	expect(uploads[1].toString()).toContain('Radio command');
	expect(uploads[1].toString().match(/name="keywords\[\]"/g)).toHaveLength(2);
	expect(uploads[1].toString().match(/name="languages\[\]"/g)).toHaveLength(2);
	await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
	await page.getByRole('button', { name: 'Clear history' }).click();
	await expect(page.locator('.result')).toHaveCount(0);
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await expect(page.getByLabel('Prompt')).toHaveValue(defaultPrompt);
	await expect(page.getByLabel('Keywords')).toHaveValue(defaultKeywords);
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
	await expect(page.getByLabel('Prompt')).toHaveValue(defaultPrompt);
	await expect(page.getByLabel('Keywords')).toHaveValue(defaultKeywords);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
	await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
});

test('compares providers with the same recording and Google phrase hints', async ({
	page
}, testInfo) => {
	await page.route('**/api/health', (route) =>
		route.fulfill({
			json: {
				status: 'ok',
				providers: [
					{ id: 'openai', model: 'gpt-transcribe' },
					{ id: 'google', model: 'short' }
				]
			}
		})
	);
	const uploads: Buffer[] = [];
	await page.route('**/api/transcribe', (route) => {
		const body = route.request().postDataBuffer()!;
		uploads.push(body);
		const google = body.toString().includes('\r\ngoogle\r\n');
		return route.fulfill({
			json: {
				text: google ? 'tango JCX 01008.' : 'タンゴ JCX 01008.',
				provider: google ? 'google' : 'openai',
				model: google ? 'short' : 'gpt-transcribe',
				elapsed_ms: 500,
				request_id: null,
				...(google
					? { results: [{ alternatives: [{ transcript: 'tango JCX 01008.', confidence: 0.9 }] }] }
					: {})
			}
		});
	});
	await page.goto('/');
	await expect(page.getByText('Server connected')).toBeVisible();
	await page.getByLabel('Prompt').fill('English radio command');
	await page.getByLabel('Keywords').fill('tango\nJCX');
	await page.locator('#audio-file').setInputFiles(file);
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.locator('.result')).toHaveCount(1);
	await page.getByLabel('Provider', { exact: true }).selectOption('google');
	await expect(page.getByLabel('Prompt')).toBeDisabled();
	await expect(page.getByLabel('Languages')).toHaveValue('en-US');
	await expect(page.locator('#model')).toHaveText('short');
	await page.getByLabel('Phrase boost').fill('12');
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.locator('.result')).toHaveCount(2);
	await expect(page.locator('.transcript').first()).toHaveText('tango JCX 01008.');
	await expect(page.locator('.result-context').first()).toContainText('Boost 12');
	expect(uploads[0].includes(audio)).toBe(true);
	expect(uploads[1].includes(audio)).toBe(true);
	expect(uploads[1].toString()).not.toContain('name="prompt"');
	expect(uploads[1].toString()).toContain('en-US');
	expect(uploads[1].toString()).toContain('tango');
	expect(uploads[1].toString()).toContain('name="boost"\r\n\r\n12');
	await page.locator('.result-context').first().click();
	await expect(page.locator('.result-details').first()).toContainText('confidence');
	await page.screenshot({ path: testInfo.outputPath('providers.png'), fullPage: true });
	await page.getByLabel('Provider', { exact: true }).selectOption('openai');
	await expect(page.getByLabel('Prompt')).toBeEnabled();
	await expect(page.getByLabel('Prompt')).toHaveValue('English radio command');
	await expect(page.getByLabel('Languages')).toHaveValue('en');
});

test('Google-only configuration selects Google and validates audio size before sending', async ({
	page
}) => {
	await page.route('**/api/health', (route) =>
		route.fulfill({
			json: {
				status: 'ok',
				providers: [{ id: 'google', model: 'short' }]
			}
		})
	);
	const uploads = await mockTranscription(page);
	await page.goto('/');
	await expect(page.getByLabel('Provider', { exact: true })).toHaveValue('google');
	await expect(page.getByLabel('Languages')).toHaveValue('en-US');
	await page.locator('#audio-file').setInputFiles({ ...file, buffer: Buffer.alloc(10_000_001) });
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.getByRole('alert')).toContainText('10 MB');
	expect(uploads).toHaveLength(0);
});

test('V1 sends complete ABNF, keeps a baseline and does not send grammar to V2', async ({
	page
}, testInfo) => {
	const grammar =
		'#ABNF 1.0 UTF-8;\nlanguage en-US;\nmode voice;\nroot $command;\npublic $command = tango;\n';
	await page.route('**/api/health', (route) =>
		route.fulfill({
			json: {
				status: 'ok',
				providers: [
					{ id: 'google', model: 'short' },
					{ id: 'google-v1', model: 'latest_short' }
				]
			}
		})
	);
	const uploads: Buffer[] = [];
	await page.route('**/api/transcribe', (route) => {
		const body = route.request().postDataBuffer()!;
		uploads.push(body);
		const v1 = body.toString().includes('\r\ngoogle-v1\r\n');
		return route.fulfill({
			json: {
				text: 'tango',
				provider: v1 ? 'google-v1' : 'google',
				model: v1 ? 'latest_short' : 'short',
				elapsed_ms: 600,
				request_id: null,
				adaptation_info: v1 ? { adaptationTimeout: uploads.length === 2 } : null
			}
		});
	});
	await page.goto('/');
	await expect(page.getByText('Server connected')).toBeVisible();
	await expect(page.getByLabel('ABNF grammar')).toBeHidden();
	await page.getByLabel('Provider', { exact: true }).selectOption('google-v1');
	await expect(page.getByLabel('ABNF grammar')).toBeVisible();
	await expect(page.getByLabel('Languages')).toHaveValue('en-US');
	await expect(page.locator('#model')).toHaveText('latest_short');
	await page.locator('#audio-file').setInputFiles(file);
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.locator('.result')).toHaveCount(1);
	expect(uploads[0].toString()).not.toContain('name="abnf"');
	await page.getByLabel('ABNF grammar').fill(grammar);
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.locator('.result')).toHaveCount(2);
	expect(uploads[1].includes(audio)).toBe(true);
	expect(uploads[1].toString()).toContain('name="abnf"');
	expect(uploads[1].toString()).toContain(grammar.replaceAll('\n', '\r\n'));
	await expect(page.locator('.result-context').first()).toContainText('With ABNF');
	await expect(page.locator('.adaptation-warning').first()).toBeVisible();
	await page.locator('.result-context').first().click();
	await expect(page.locator('.result-details').first()).toContainText('public $command = tango;');
	await page.screenshot({ path: testInfo.outputPath('abnf.png'), fullPage: true });
	await page.getByLabel('Provider', { exact: true }).selectOption('google');
	await expect(page.getByLabel('ABNF grammar')).toBeHidden();
	await page.getByRole('button', { name: 'Transcribe audio' }).click();
	await expect(page.locator('.result')).toHaveCount(3);
	expect(uploads[2].toString()).not.toContain('name="abnf"');
	await page.getByLabel('Provider', { exact: true }).selectOption('google-v1');
	await expect(page.getByLabel('ABNF grammar')).toHaveValue(grammar);
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await expect(page.getByLabel('ABNF grammar')).toHaveValue('');
	await expect(page.getByLabel('Languages')).toHaveValue('en-US');
});
