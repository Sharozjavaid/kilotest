// Flow 6: create a style, make it the default, see New batch start from it; set a weekly goal
// and a reminder; reload and see both persisted by the server.
import { assert, openApp, seeText, shot } from '../lib.mjs';

export default async function styles(ctx) {
  const { page, browser, errors } = await openApp(ctx, { userId: ctx.userId, permissions: ['notifications'] });
  try {
    // A style: UGC ad, tight pacing, captions on, the default for new batches.
    await page.getByRole('tab', { name: /Styles/ }).or(page.getByRole('link', { name: /Styles/ })).first().click();
    await page.getByTestId('new-style').click();
    await page.getByTestId('style-name').fill('Bold UGC');
    await page.getByRole('radiogroup', { name: 'Kind of video' }).getByRole('radio', { name: 'UGC ad' }).click();
    await page.getByRole('switch', { name: 'Burn in captions' }).click();
    await page.getByRole('radiogroup', { name: 'Caption style' }).getByRole('radio').nth(1).click();
    // A first style starts as the default; make sure it is on.
    if ((await page.getByTestId('style-default').getAttribute('aria-checked')) !== 'true') await page.getByTestId('style-default').click();
    await shot(page, '23-style-edit');
    const saved = page.waitForResponse((r) => r.url().endsWith('/v1/styles') && r.request().method() === 'POST');
    await page.getByTestId('save-style').click();
    const res = await saved;
    assert(res.status() === 201, `POST /styles answered ${res.status()}: ${await res.text()}`);
    const style = await res.json();
    await seeText(page, 'Bold UGC');
    await seeText(page, 'Default');
    await shot(page, '24-styles');
    const server = (await ctx.api.styles()).styles.find((s) => s.id === style.id);
    assert(server?.isDefault && server.settings.mode === 'ugc_ad' && server.settings.captions, `the style was not stored as made: ${JSON.stringify(server)}`);

    // New batch starts from the default style.
    await page.goto(ctx.appUrl + '/new-batch', { waitUntil: 'networkidle' });
    await seeText(page, 'Pick clips from your library');
    const ugc = page.getByRole('radiogroup', { name: 'Kind of video' }).getByRole('radio', { name: 'UGC ad' });
    await ugc.waitFor();
    assert((await ugc.getAttribute('aria-checked')) === 'true', 'New batch did not start from the default style (mode)');
    assert((await page.getByRole('switch', { name: 'Burn in captions' }).getAttribute('aria-checked')) === 'true', 'New batch did not start from the default style (captions)');
    assert((await page.getByTestId(`style-chip-${style.id}`).getAttribute('aria-label')).includes('Bold UGC'), 'the style chip is missing');
    await shot(page, '25-new-batch-from-style');

    // Weekly goal and a reminder.
    await page.goto(ctx.appUrl + '/goal', { waitUntil: 'networkidle' });
    await seeText(page, 'Videos per week');
    const per = page.locator('[aria-label="videos per week"]').first();
    const value = async () => Number(/\d+/.exec(await per.innerText())?.[0]);
    while ((await value()) < 5) await page.getByRole('button', { name: 'More videos per week' }).click();
    while ((await value()) > 5) await page.getByRole('button', { name: 'Fewer videos per week' }).click();
    await page.getByTestId('reminder-toggle').click();
    await page.getByTestId('reminder-hour').waitFor();
    await page.getByTestId('hour-later').click();
    await page.getByTestId('hour-later').click();
    const goalSaved = page.waitForResponse((r) => r.url().endsWith('/v1/goal') && r.request().method() === 'PUT');
    await page.getByTestId('save-goal').click();
    assert((await goalSaved).status() === 200, 'PUT /goal failed');
    await shot(page, '26-goal');
    const g = await ctx.api.goal();
    ctx.log(`  goal stored: ${g.videosPerWeek}/week, reminder ${g.reminder.enabled} at ${g.reminder.hour}:00 ${g.reminder.timeZone}`);
    assert(g.videosPerWeek === 5 && g.reminder.enabled, 'the goal or reminder was not stored');

    // Reload: both come back from the server.
    await page.reload({ waitUntil: 'networkidle' });
    await seeText(page, 'Videos per week');
    assert((await value()) === 5, 'the goal did not survive a reload');
    assert((await page.getByTestId('reminder-toggle').getAttribute('aria-checked')) === 'true', 'the reminder did not survive a reload');
    await seeText(page, `At ${g.reminder.hour > 12 ? g.reminder.hour - 12 : g.reminder.hour}`);
    await page.goto(ctx.appUrl + '/styles', { waitUntil: 'networkidle' });
    await seeText(page, 'Bold UGC');
    await page.goto(ctx.appUrl + '/', { waitUntil: 'networkidle' });
    await seeText(page, /of 5 videos posted/);
    assert(!errors.length, `browser errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await browser.close();
  }
}
