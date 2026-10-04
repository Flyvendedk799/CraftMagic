import AxeBuilder from '@axe-core/playwright';
/** Portable real-browser regression suite. A disposable local server, no model calls or live accounts. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.CM_TEST_PORT ?? 3018),
  origin = `http://127.0.0.1:${port}`;
const output = path.resolve(
  process.env.CM_SHOTS ?? path.join(root, 'test-artifacts/workspace'),
);
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_ORIGIN: origin,
    DATABASE_URL:
      process.env.CM_USE_TEST_DATABASE === '1' ? process.env.DATABASE_URL : '',
    SESSION_SECRET: 'workspace-fixture-session-secret-32-characters',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));
let browser, page;
const results = [];
const pageErrors = [];
const test = async (name, run) => {
  await run();
  results.push(name);
  console.log(`PASS ${name}`);
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(origin + '/api/health');
      if (response.ok) break;
    } catch {}
    if (i === 99) throw Error('Server did not become ready: ' + serverLog);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE,
    headless: true,
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !== origin &&
      url.protocol !== 'blob:' &&
      url.protocol !== 'data:'
    )
      return route.abort();
    if (
      url.pathname.startsWith('/api/generate') &&
      route.request().method() !== 'GET'
    )
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Model calls disabled in browser tests',
        }),
      });
    return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  const ready = async () => {
    await page.locator('.workspace').waitFor();
    await page.waitForTimeout(250);
  };
  const dock = (side) => page.locator(`.workspace-dock--${side}`);
  const selectTab = async (side, name) => {
    await dock(side).getByRole('tab', { name, exact: true }).click();
  };
  const mode = async (name) => {
    await page
      .getByRole('navigation', { name: 'Studio workspaces' })
      .getByRole('button', { name, exact: true })
      .click();
    await ready();
  };
  await page.goto(origin + '/studio?build=cottage');
  await ready();
  await page.waitForFunction(
    () =>
      document.querySelector('.editor')?.getAttribute('data-remaining') === '0',
  );
  await test('dedicated workbench gives canvas an unobstructed rectangle', async () => {
    const stage = await page.locator('#workspace-stage').boundingBox(),
      left = await dock('left').boundingBox(),
      right = await dock('right').boundingBox();
    assert(stage && left && right);
    assert(stage.x >= left.x + left.width);
    assert(stage.x + stage.width <= right.x);
    assert(stage.width > 850);
    assert.equal(await page.locator('.workspace .nav').count(), 0);
  });
  await page.screenshot({ path: path.join(output, '01-build-workspace.png') });
  await test('shape parameters stay out of the active tool panel', async () => {
    await selectTab('left', 'Shape');
    assert(await page.getByText('Scale', { exact: true }).isVisible());
    await selectTab('left', 'Tools');
    assert(await dock('left').locator('[data-tool="place"]').isVisible());
  });
  await test('material browser filters and selects a real registered block', async () => {
    await selectTab('left', 'Assets');
    await page
      .getByRole('searchbox', { name: 'Search material library' })
      .fill('stone bricks');
    await page
      .getByRole('button', { name: 'Use Stone Bricks', exact: true })
      .click();
    assert.equal(
      await page
        .getByRole('button', { name: 'Use Stone Bricks', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    );
  });
  await test('material favourites persist across the panel lifecycle', async () => {
    await page
      .getByRole('button', { name: 'Favourite Stone Bricks', exact: true })
      .click();
    await page
      .getByRole('searchbox', { name: 'Search material library' })
      .fill('');
    await page.getByRole('button', { name: 'Favourites', exact: true }).click();
    assert(
      await page
        .getByRole('button', { name: 'Use Stone Bricks', exact: true })
        .isVisible(),
    );
    await selectTab('left', 'Tools');
  });
  await test('command palette can select an actual tool', async () => {
    await page.keyboard.press('Control+k');
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('tool erase');
    await page.keyboard.press('Enter');
    assert.equal(
      await page.locator('.editor').getAttribute('data-tool'),
      'erase',
    );
  });
  await test('empty command results and Escape do not edit the scene', async () => {
    const before = await page.locator('.editor').getAttribute('data-edits');
    await page.keyboard.press('Control+k');
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('zzzz no action');
    assert(await page.getByText('No matching action').isVisible());
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(
      await page.getByRole('dialog', { name: 'Command palette' }).count(),
      0,
    );
    assert.equal(
      await page.locator('.editor').getAttribute('data-edits'),
      before,
    );
  });
  await test('settings modal traps focus and restores its opener', async () => {
    await page
      .getByRole('button', { name: 'Workspace settings', exact: true })
      .click();
    await page.keyboard.press('Shift+Tab');
    assert(
      await page
        .getByRole('dialog', { name: 'Workspace settings' })
        .evaluate((el) => el.contains(document.activeElement)),
    );
    await page.keyboard.press('Escape');
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label'),
      ),
      'Workspace settings',
    );
  });
  await test('keyboard resizer changes and remembers dock width', async () => {
    const separator = page.getByRole('separator', {
      name: 'Resize left panel',
    });
    await separator.focus();
    const before = Number(await separator.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowRight');
    assert.equal(
      Number(await separator.getAttribute('aria-valuenow')),
      before + 8,
    );
    await page.reload();
    await ready();
    assert.equal(
      Number(await separator.getAttribute('aria-valuenow')),
      before + 8,
    );
  });
  await test('focus mode expands the canvas and exits without resetting the model', async () => {
    const before = await page.locator('#workspace-stage').boundingBox();
    await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
    const expanded = await page.locator('#workspace-stage').boundingBox();
    assert(expanded.width > before.width + 400);
    await page.keyboard.press('F8');
    assert.equal(
      await page.locator('.workspace').getAttribute('data-focus'),
      'false',
    );
  });
  await test('delivery reveals the actual export action and downloads a schematic', async () => {
    await page.getByRole('button', { name: 'Deliver', exact: true }).click();
    const button = page.getByRole('button', {
      name: 'Download schematic',
      exact: true,
    });
    await button.waitFor({ state: 'visible' });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      button.click(),
    ]);
    const bytes = await readFile(await download.path());
    assert(bytes.length > 100);
    assert(download.suggestedFilename().endsWith('.schem'));
  });
  await test('program JSON export remains available', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Program JSON', exact: true }).click(),
    ]);
    const data = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(data.version, 1);
    assert(Array.isArray(data.components));
  });
  await test('outliner search filters real generated components', async () => {
    await selectTab('right', 'Inspect');
    await page
      .getByRole('searchbox', { name: 'Search components' })
      .fill('roof');
    assert((await page.locator('.outliner__row').count()) > 0);
    await page
      .getByRole('searchbox', { name: 'Search components' })
      .fill('no-such-part');
    assert(
      await page
        .getByText('No components match.', { exact: false })
        .isVisible(),
    );
    await page
      .getByRole('button', { name: 'Clear filters', exact: true })
      .click();
  });
  await mode('Plan');
  await test('floorplan opens alongside live 3D and real inspector', async () => {
    assert(await page.locator('.arch__plan').isVisible());
    assert(await page.locator('.arch__model').isVisible());
    assert(
      await dock('right').getByText('Selection', { exact: true }).isVisible(),
    );
  });
  await test('architecture template is selected from assets, not mixed with drawing tools', async () => {
    await selectTab('left', 'Assets');
    await page
      .getByRole('button', { name: 'Two-room cottage', exact: true })
      .click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.arch__plan-empty').count(), 0);
  });
  await test('split view can isolate either canvas and restore both', async () => {
    const select = page.getByRole('combobox', { name: 'Canvas layout' });
    await select.selectOption('primary');
    assert(!(await page.locator('.arch__model').isVisible()));
    await select.selectOption('preview');
    assert(!(await page.locator('.arch__plan').isVisible()));
    assert(await page.locator('.arch__model').isVisible());
    await select.selectOption('both');
  });
  await test('floorplan save and file manager find the named browser draft', async () => {
    await page
      .getByRole('button', { name: 'Save draft', exact: true })
      .first()
      .click();
    await page
      .getByRole('button', { name: 'Open', exact: true })
      .first()
      .click();
    await page.getByRole('dialog', { name: 'Your work' }).waitFor();
    await page
      .getByRole('navigation', { name: 'File filters' })
      .getByRole('button', { name: /Floorplans/ })
      .click();
    assert((await page.locator('.workspace-file').count()) > 0);
  });
  await test('inline rename cancellation never mutates the saved file', async () => {
    await page.locator('.workspace-file__select').first().click();
    const before = await page
      .locator('.workspace-files__selection strong')
      .textContent();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'New file name' })
      .fill('Do not save this');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(
      await page.locator('.workspace-files__selection strong').textContent(),
      before,
    );
  });
  await test('inline file rename commits and is searchable', async () => {
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'New file name' })
      .fill('Workspace QA Cottage');
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await page
      .getByRole('searchbox', { name: 'Find Studio work' })
      .fill('Workspace QA');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.workspace-file').count(), 1);
  });
  await test('delete confirmation can be cancelled with no mutation', async () => {
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    assert(
      await page
        .getByText('Delete this saved file? This cannot be undone.')
        .isVisible(),
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.locator('.workspace-file').count(), 1);
    await page.keyboard.press('Escape');
  });
  await mode('World');
  await page.waitForTimeout(1200);
  await test('world terrain tools, map inspector and placement shelf have distinct docks', async () => {
    assert(
      await dock('left')
        .getByRole('tab', { name: 'Tools', exact: true })
        .isVisible(),
    );
    await selectTab('left', 'Assets');
    assert(await page.getByText('Components', { exact: true }).isVisible());
    await selectTab('right', 'Map');
    assert(await page.getByText('Extent', { exact: true }).isVisible());
    await selectTab('left', 'Tools');
  });
  await test('world command selects the terrain tool', async () => {
    await page.keyboard.press('Control+k');
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('tool lower');
    await page.keyboard.press('Enter');
    assert.equal(
      await page.locator('.world').getAttribute('data-tool'),
      'lower',
    );
  });
  await page.screenshot({ path: path.join(output, '02-world-workspace.png') });
  await test('document tabs retain independent routes across all three editors', async () => {
    assert(
      (await page
        .getByRole('toolbar', { name: 'Open documents' })
        .locator('[data-document-tab]')
        .count()) >= 3,
    );
    await page
      .getByRole('toolbar', { name: 'Open documents' })
      .locator('[data-document-tab]')
      .filter({ hasText: 'Oak Cottage' })
      .click();
    await ready();
    assert(await page.locator('.editor').isVisible());
  });
  await test('history dialog opens and closes without consuming editor input', async () => {
    await page
      .getByRole('button', { name: 'Project history', exact: true })
      .click();
    assert(
      await page.getByRole('dialog', { name: 'Project history' }).isVisible(),
    );
    await page.keyboard.press('Escape');
    assert.equal(
      await page.getByRole('dialog', { name: 'Project history' }).count(),
      0,
    );
  });
  for (const width of [1200, 900, 720, 390]) {
    await test(`workspace fits ${width}px without horizontal page overflow`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      );
      if (width <= 760) {
        await page
          .getByRole('navigation', { name: 'Workspace view' })
          .getByRole('button', { name: 'Tools', exact: true })
          .click();
        assert(await dock('left').isVisible());
        await page
          .getByRole('navigation', { name: 'Workspace view' })
          .getByRole('button', { name: 'Inspector', exact: true })
          .click();
        assert(await dock('right').isVisible());
        await page
          .getByRole('navigation', { name: 'Workspace view' })
          .getByRole('button', { name: 'Canvas', exact: true })
          .click();
      }
      await page.screenshot({
        path: path.join(output, `responsive-${width}.png`),
      });
    });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mode('Plan');
  await page.screenshot({ path: path.join(output, '03-plan-workspace.png') });
  await test('new-document dialog cancels without creating a tab', async () => {
    const before = await page
      .getByRole('toolbar', { name: 'Open documents' })
      .locator('[data-document-tab]')
      .count();
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'New document name' })
      .fill('Cancelled work');
    await page.keyboard.press('Escape');
    assert.equal(
      await page
        .getByRole('toolbar', { name: 'Open documents' })
        .locator('[data-document-tab]')
        .count(),
      before,
    );
  });
  let planA, planB;
  async function createPlanDocument(name) {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page
      .getByRole('group', { name: 'Document type' })
      .getByRole('button', { name: /Floorplan/ })
      .click();
    await page.getByRole('textbox', { name: 'New document name' }).fill(name);
    await page
      .getByRole('combobox', { name: 'Starting floorplan' })
      .selectOption('studio');
    await page.getByRole('button', { name: 'Create & open' }).click();
    await ready();
    await selectTab('left', 'Storeys');
    return page.locator('.arch').getAttribute('data-plan-id');
  }
  await test('new floorplans have separate document identities and retained drafts', async () => {
    planA = await createPlanDocument('QA Plan A');
    await page
      .locator('.floors')
      .getByRole('textbox', { name: 'Name', exact: true })
      .fill('Edited floor A');
    planB = await createPlanDocument('QA Plan B');
    assert.notEqual(planA, planB);
    await page
      .locator('.floors')
      .getByRole('textbox', { name: 'Name', exact: true })
      .fill('Edited floor B');
    await page
      .getByRole('toolbar', { name: 'Open documents' })
      .locator('[data-document-tab]')
      .filter({ hasText: 'Oak Cottage' })
      .click();
    await ready();
  });
  await test('global undo opens the exact plan that owns each edit', async () => {
    await page
      .getByRole('button', { name: 'Undo', exact: true })
      .first()
      .click();
    await ready();
    assert.equal(
      await page.locator('.arch').getAttribute('data-plan-id'),
      planB,
    );
    await selectTab('left', 'Storeys');
    assert.equal(
      await page
        .locator('.floors')
        .getByRole('textbox', { name: 'Name', exact: true })
        .inputValue(),
      'Ground floor',
    );
    await page
      .getByRole('button', { name: 'Undo', exact: true })
      .first()
      .click();
    await ready();
    assert.equal(
      await page.locator('.arch').getAttribute('data-plan-id'),
      planA,
    );
    await selectTab('left', 'Storeys');
    assert.equal(
      await page
        .locator('.floors')
        .getByRole('textbox', { name: 'Name', exact: true })
        .inputValue(),
      'Ground floor',
    );
  });
  await test('global redo crosses documents without editing the wrong floorplan', async () => {
    await page
      .getByRole('button', { name: 'Redo', exact: true })
      .first()
      .click();
    await ready();
    assert.equal(
      await page.locator('.arch').getAttribute('data-plan-id'),
      planA,
    );
    await page
      .getByRole('button', { name: 'Redo', exact: true })
      .first()
      .click();
    await ready();
    assert.equal(
      await page.locator('.arch').getAttribute('data-plan-id'),
      planB,
    );
    await selectTab('left', 'Storeys');
    assert.equal(
      await page
        .locator('.floors')
        .getByRole('textbox', { name: 'Name', exact: true })
        .inputValue(),
      'Edited floor B',
    );
  });
  await test('blank build wizard applies its requested volume', async () => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page
      .getByRole('group', { name: 'Document type' })
      .getByRole('button', { name: /Structure/ })
      .click();
    await page
      .getByRole('textbox', { name: 'New document name' })
      .fill('QA 16 block build');
    await page
      .getByRole('combobox', { name: 'Build volume' })
      .selectOption('16');
    await page.getByRole('button', { name: 'Create & open' }).click();
    await ready();
    assert(
      (await page.locator('.editor').getAttribute('data-build')).startsWith(
        'gen:',
      ),
    );
    await selectTab('right', 'Inspect');
    assert(
      await dock('right').getByText('16×16×16', { exact: true }).isVisible(),
    );
  });
  if (process.env.CM_USE_TEST_DATABASE === '1') {
    await test('signed-in account lifecycle uses the real local API and database', async () => {
      const response = await context.request.post(
        origin + '/api/auth/register',
        {
          headers: { Origin: origin },
          data: {
            email: `workspace-${Date.now()}@example.test`,
            password: 'Only-a-local-fixture-password-123',
          },
        },
      );
      assert.equal(response.status(), 201, await response.text());
      await page.goto(origin + '/studio?build=cottage');
      await ready();
      await page
        .getByRole('button', { name: 'Save to library', exact: true })
        .first()
        .waitFor({ state: 'visible' });
    });
    await test('failed account save remains actionable and retry creates one library document', async () => {
      let fail = true;
      const intercept = (route) =>
        route.request().method() === 'POST' && fail
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'Fixture storage unavailable' }),
            })
          : route.continue();
      await page.route('**/api/builds', intercept);
      await page
        .getByRole('button', { name: 'Save to library', exact: true })
        .first()
        .click();
      await page
        .getByText('Fixture storage unavailable', { exact: false })
        .first()
        .waitFor();
      fail = false;
      await page
        .getByRole('button', { name: 'Save to library', exact: true })
        .first()
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector('.editor')
          ?.getAttribute('data-build')
          ?.startsWith('lib:'),
      );
      await page.unroute('**/api/builds', intercept);
      const response = await context.request.get(origin + '/api/builds');
      assert.equal((await response.json()).builds.length, 1);
    });
    await test('account file rename persists through the API and opens the same document', async () => {
      await page
        .getByRole('button', { name: 'Open', exact: true })
        .first()
        .click();
      await page
        .getByRole('navigation', { name: 'File filters' })
        .getByRole('button', { name: /Account/ })
        .click();
      await page.locator('.workspace-file__select').first().click();
      await page.getByRole('button', { name: 'Rename', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'New file name' })
        .fill('Account QA Structure');
      await page
        .getByRole('button', { name: 'Save name', exact: true })
        .click();
      await page
        .getByText('Account QA Structure', { exact: true })
        .first()
        .waitFor();
      const response = await context.request.get(origin + '/api/builds');
      assert.equal(
        (await response.json()).builds[0].name,
        'Account QA Structure',
      );
      await page
        .getByRole('button', { name: 'Open', exact: true })
        .last()
        .click();
      await ready();
    });
    await test('a linked plan reopens the library structure rather than a detached draft', async () => {
      await mode('Plan');
      await page.waitForTimeout(500);
      assert(new URL(page.url()).searchParams.get('plan')?.startsWith('lib:'));
      await selectTab('left', 'Assets');
      await page
        .getByRole('button', { name: 'Two-room cottage', exact: true })
        .click();
      await page.waitForTimeout(1600);
      await mode('Build');
      await page.waitForTimeout(700);
      assert(await page.locator('.editor').isVisible());
      assert(new URL(page.url()).searchParams.get('build')?.startsWith('lib:'));
    });
    await test('account delete requires its own explicit confirmation and removes the row', async () => {
      await page
        .getByRole('button', { name: 'Open', exact: true })
        .first()
        .click();
      await page
        .getByRole('navigation', { name: 'File filters' })
        .getByRole('button', { name: /Account/ })
        .click();
      await page.locator('.workspace-file__select').first().click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page
        .getByRole('button', { name: 'Delete file', exact: true })
        .click();
      await page.waitForTimeout(250);
      const response = await context.request.get(origin + '/api/builds');
      assert.equal((await response.json()).builds.length, 0);
      await page.keyboard.press('Escape');
    });
  }
  await test('manual block edit, undo and redo still operate on the real voxel model', async () => {
    await page.goto(origin + '/studio?build=cottage');
    await ready();
    await page.waitForFunction(
      () =>
        document.querySelector('.editor')?.getAttribute('data-remaining') ===
        '0',
    );
    await selectTab('left', 'Tools');
    await dock('left').locator('[data-tool="place"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector('.editor')?.getAttribute('data-assembling') ===
          'false' &&
        document.querySelector('.editor')?.getAttribute('data-remaining') ===
          '0',
    );
    const initial = Number(
      await page.locator('.editor').getAttribute('data-edits'),
    );
    const box = await page.locator('.editor__canvas canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.62);
    await page.locator('.hover-readout strong').waitFor({ state: 'visible' });
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.62);
    await page.waitForFunction(
      (before) =>
        Number(document.querySelector('.editor')?.getAttribute('data-edits')) >
        before,
      initial,
    );
    await page
      .getByRole('button', { name: 'Undo', exact: true })
      .first()
      .click();
    await page.waitForFunction(
      (before) =>
        Number(
          document.querySelector('.editor')?.getAttribute('data-edits'),
        ) === before,
      initial,
    );
    await page
      .getByRole('button', { name: 'Redo', exact: true })
      .first()
      .click();
    await page.waitForFunction(
      (before) =>
        Number(document.querySelector('.editor')?.getAttribute('data-edits')) >
        before,
      initial,
    );
  });
  await test('legacy editor and floorplan links retain their document parameters', async () => {
    await page.goto(origin + '/editor?build=tower&layer=3');
    await ready();
    assert.equal(new URL(page.url()).pathname, '/studio');
    assert.equal(new URL(page.url()).searchParams.get('build'), 'tower');
    assert.equal(new URL(page.url()).searchParams.get('layer'), '3');
    await page.goto(origin + '/layouter?plan=local%3Amissing-fixture');
    await ready();
    assert.equal(new URL(page.url()).searchParams.get('mode'), 'arch');
    assert.equal(
      new URL(page.url()).searchParams.get('plan'),
      'local:missing-fixture',
    );
    await page.goto(origin + '/studio?build=cottage');
    await ready();
  });
  if (process.env.CM_USE_TEST_DATABASE === '1') {
    await test('file-list failure is visible and retry reloads account data', async () => {
      let fail = true;
      const intercept = (route) =>
        fail
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'Fixture list unavailable' }),
            })
          : route.continue();
      await page.route('**/api/worlds', intercept);
      await page
        .getByRole('button', { name: 'Open', exact: true })
        .first()
        .click();
      await page.getByText('Could not load maps.', { exact: false }).waitFor();
      fail = false;
      await page
        .getByRole('button', { name: 'Retry loading', exact: true })
        .click();
      await page
        .getByText('Could not load maps.', { exact: false })
        .waitFor({ state: 'hidden' });
      assert.equal(
        await page.getByText('Could not load maps.', { exact: false }).count(),
        0,
      );
      await page.keyboard.press('Escape');
      await page.unroute('**/api/worlds', intercept);
    });
    await test('world creation persists to the account and finishes opening', async () => {
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page
        .getByRole('group', { name: 'Document type' })
        .getByRole('button', { name: /World/ })
        .click();
      await page
        .getByRole('textbox', { name: 'New document name' })
        .fill('QA Named World');
      await page
        .getByRole('combobox', { name: 'World extent' })
        .selectOption('128');
      await page.getByRole('button', { name: 'Create & open' }).click();
      await page.waitForURL((url) => url.searchParams.has('world'));
      await ready();
      await page
        .locator('.workspace-document-state')
        .waitFor({ state: 'hidden' });
      assert(new URL(page.url()).searchParams.get('world'));
      const response = await context.request.get(origin + '/api/worlds');
      assert(
        (await response.json()).worlds.some(
          (world) => world.name === 'QA Named World',
        ),
      );
    });
    await test('missing world never exposes a saveable placeholder under its identity', async () => {
      await page.goto(
        origin +
          '/studio?mode=world&world=00000000-0000-0000-0000-000000000000',
      );
      await ready();
      await page.getByRole('button', { name: 'Retry opening world' }).waitFor();
      assert(
        await page
          .getByRole('button', { name: 'Save map', exact: true })
          .first()
          .isDisabled(),
      );
      await page.getByRole('button', { name: 'Retry opening world' }).click();
      await page.getByRole('button', { name: 'Retry opening world' }).waitFor();
      await page.getByRole('button', { name: 'Open browser draft' }).click();
      await ready();
      assert.notEqual(
        new URL(page.url()).searchParams.get('world'),
        '00000000-0000-0000-0000-000000000000',
      );
    });
  }
  await test('cancelling browser Back restores both the studio URL and the edited document', async () => {
    await page.goto(origin + '/dashboard');
    await page.getByRole('link', { name: 'Studio', exact: true }).click();
    await ready();
    await selectTab('left', 'Tools');
    await page.waitForFunction(
      () =>
        document.querySelector('.editor')?.getAttribute('data-remaining') ===
        '0',
    );
    await dock('left').locator('[data-tool="place"]').click();
    const box = await page.locator('.editor__canvas canvas').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.62);
    await page.waitForFunction(
      () =>
        Number(document.querySelector('.editor')?.getAttribute('data-edits')) >
        0,
    );
    await page
      .locator('.workspace-status')
      .getByText('Unsaved changes', { exact: true })
      .waitFor();
    page.removeAllListeners('dialog');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/studio');
    await ready();
    assert(await page.locator('.editor').isVisible());
    assert(
      Number(await page.locator('.editor').getAttribute('data-edits')) > 0,
    );
    page.on('dialog', (dialog) => dialog.accept());
  });
  const accessibility = [];
  for (const workspaceMode of ['Build', 'Plan', 'World']) {
    if (workspaceMode === 'Build') {
      await page.goto(origin + '/studio?build=cottage');
      await ready();
    } else if (workspaceMode === 'Plan') {
      await page.goto(origin + '/studio?mode=arch');
      await ready();
    } else {
      await mode(workspaceMode);
    }
    for (const side of ['left', 'right']) {
      const names = await dock(side).getByRole('tab').allTextContents();
      for (const name of names) {
        await selectTab(side, name.trim());
        await page.waitForTimeout(180);
        const report = await new AxeBuilder({ page })
          .include('.workspace')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        accessibility.push(
          ...report.violations.map((v) => ({
            mode: workspaceMode,
            panel: name,
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.map((n) => ({
              target: n.target,
              summary: n.failureSummary,
            })),
          })),
        );
      }
    }
  }
  await test('all three editors and every dock panel pass automated WCAG A/AA checks', async () =>
    assert.deepEqual(accessibility, []));
  await test('no uncaught browser exceptions', async () =>
    assert.deepEqual(pageErrors, []));
  await page.goto(origin + '/studio?build=cottage');
  await ready();
  await selectTab('left', 'Tools'); await selectTab('right', 'Inspect');
  await page.waitForFunction(() => document.querySelector('.editor')?.getAttribute('data-assembling') === 'false' && document.querySelector('.editor')?.getAttribute('data-remaining') === '0');
  await page.screenshot({path:path.join(output,'studio-finished.png')});
  console.log(
    `PASS: ${results.length} workspace browser scenarios. Screenshots: ${output}`,
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error(error);
  console.error(serverLog.slice(-2500));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
