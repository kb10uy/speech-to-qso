import { expect, test, type Locator, type Page } from '@playwright/test';

async function setUpSession(page: Page) {
    await page.goto('./');
    // Exact: once the app is ready, the "set up the session" banner matches "Session" too.
    await page.getByRole('button', { name: 'Session', exact: true }).click();
    await page.getByLabel('Operator callsign').fill('jj1abc');
    await page.getByLabel('Frequency anchor (MHz)').fill('433');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('header')).toContainText('JJ1ABC');
}

async function openMenu(page: Page, item: string) {
    await page.getByRole('button', { name: 'JJ1ABC' }).click();
    await page.getByRole('menuitem', { name: item }).click();
}

/** Records whether the element gets the class at some point, since a flash lasts only 0.5 s. */
async function watchClass(locator: Locator, className: string) {
    await locator.evaluate((element, className) => {
        new MutationObserver(() => {
            if (element.classList.contains(className)) element.setAttribute('data-seen', className);
        }).observe(element, { attributes: true, attributeFilter: ['class'] });
    }, className);
    return () => expect(locator).toHaveAttribute('data-seen', className);
}

async function type(page: Page, command: string) {
    const input = page.getByPlaceholder(/e\.g\. jl1his/);
    if (!(await input.isVisible())) await page.getByText('Type a command').click();
    await input.fill(command);
    await input.press('Enter');
}

test('fills a QSO from typed DSL commands and logs it locally', async ({ page }) => {
    await setUpSession(page);

    const callsignFlashed = await watchClass(
        page.getByLabel('Draft QSO').locator('[data-field="callsign"]'),
        'flash'
    );
    await type(page, 'juliett lima one hotel india sierra');
    await callsignFlashed();
    await type(page, 'received five seven');
    await type(page, 'frequency point nine four');
    await type(page, 'jcx one zero zero one zero one');
    await type(page, 'card requested');
    await page.getByRole('textbox', { name: /^Name/ }).fill(' 太郎 ');
    await page.getByRole('textbox', { name: /^QTH/ }).fill('東京都港区');

    const draft = page.getByLabel('Draft QSO');
    await expect(draft).toContainText('JL1HIS');
    await expect(draft).toContainText('57');
    await expect(draft).toContainText('432.940');
    await expect(draft).toContainText('100101');
    await expect(draft).toContainText('Requested');

    const commandFlashed = await watchClass(page.getByPlaceholder(/e\.g\. jl1his/), 'flash-error');
    await type(page, 'received banana');
    await commandFlashed();
    await page.getByText(/^Recent utterances/).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'banana' })).toContainText(
        'unexpected "banana" in RST'
    );

    await page.getByRole('button', { name: 'LOG QSO' }).click();
    await expect(page.getByRole('status')).toContainText('JL1HIS logged locally');
    // The next draft keeps the frequency but nothing QSO-specific.
    await expect(draft).toContainText('CALLSIGN');
    await expect(draft).toContainText('432.940');
    await expect(page.getByRole('textbox', { name: /^QTH/ })).toHaveValue('');

    await page.reload();
    await openMenu(page, 'Log');
    await expect(page.locator('li', { hasText: 'JL1HIS' })).toContainText('432.940 FM · 59/57');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export ADIF' }).click();
    const file = await (await download).path();
    const adif = await (await import('node:fs/promises')).readFile(file, 'utf8');
    expect(adif).toContain('<CALL:6>JL1HIS');
    expect(adif).toContain('<QSL_SENT:1>R');
    expect(adif).toContain('<CNTY:6>100101 <NAME:2>太郎 <QTH:5>東京都港区 ');
});

test('logs contest QSOs with numbered exchanges', async ({ page }) => {
    await setUpSession(page);

    await page.getByRole('button', { name: 'Contest', exact: true }).click();
    await page.getByLabel('Log QSOs as contest QSOs').check();
    await page.getByLabel('Contest ID').fill('all-ja1');
    await page.getByRole('textbox', { name: /^Sent number/ }).fill('{serial}m');
    await page.getByLabel('Next serial number').fill('7');
    await page.getByLabel(/Put the RST in front/).check();
    await expect(page.getByLabel('Next sent number')).toHaveText('59007M');
    await page.getByRole('button', { name: 'Save' }).click();

    const draft = page.getByLabel('Draft QSO');
    const sent = draft.locator('[data-field="rstSent"]');
    const received = draft.locator('[data-field~="exchangeReceived"]');
    await expect(sent).toContainText('59 007M');
    await expect(received).toContainText('59 ---');

    await type(page, 'jl1his frequency point nine four');
    await page.getByRole('button', { name: 'LOG QSO' }).click();
    await expect(page.getByRole('status')).toContainText('Received number is missing');

    const receivedFlashed = await watchClass(received, 'flash');
    await type(page, 'received five seven number one zero zero one hotel');
    await receivedFlashed();
    await expect(received).toContainText('57 1001H');
    await page.getByRole('button', { name: 'LOG QSO' }).click();
    await expect(page.getByRole('status')).toContainText('JL1HIS logged locally');
    await expect(sent).toContainText('59 008M');
    await expect(received).toContainText('59 ---');

    await openMenu(page, 'Log');
    await expect(page.locator('li', { hasText: 'JL1HIS' })).toContainText('NR 59007M/571001H');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export ADIF' }).click();
    const file = await (await download).path();
    const adif = await (await import('node:fs/promises')).readFile(file, 'utf8');
    expect(adif).toContain('<CONTEST_ID:7>ALL-JA1 <STX_STRING:6>59007M <SRX_STRING:7>571001H ');
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

test('switches to the bundled Japanese model and takes Japanese commands', async ({ page }) => {
    await setUpSession(page);

    await openMenu(page, 'Settings');
    await page.getByRole('combobox', { name: /^Vosk model/ }).selectOption('ja');
    await page.getByRole('button', { name: 'Save' }).click();
    // Saving is asynchronous (IndexedDB); reloading before it finishes would lose the change.
    await expect(page.getByRole('button', { name: 'Saved ✓' })).toBeVisible();
    await page.reload();
    await openMenu(page, 'Settings');
    await expect(page.getByRole('combobox', { name: /^Vosk model/ })).toHaveValue('ja');

    await page.getByRole('button', { name: 'QSO' }).click();
    await type(
        page,
        'ジュリエット リマ ワン ホテル インディア シエラ 受信 ファイブ セブン カード ワンウェイ'
    );
    const draft = page.getByLabel('Draft QSO');
    await expect(draft).toContainText('JL1HIS');
    await expect(draft).toContainText('57');
    await expect(draft).toContainText('One Way');
    await page.getByText(/^Recent utterances/).click();
    await expect(page.getByRole('listitem').first()).toContainText(
        'J L 1 H I S RCVD 5 7 QSL ONE WAY'
    );
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
