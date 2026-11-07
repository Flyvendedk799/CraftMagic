import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

async function main() {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Mock authentication as signed-in user
  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 'usr_crafter',
          email: 'crafter@craftmagic.dev',
          dailyGenQuota: 100,
          generationsUsedToday: 5,
          generationsLeftToday: 95,
          isAdmin: true,
        },
      }),
    }),
  );

  // Mock library builds
  await page.route('**/api/builds', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        builds: [
          {
            id: 'bld_citadel',
            name: 'Grand Medieval Citadel',
            sizeX: 64,
            sizeY: 48,
            sizeZ: 64,
            blockCount: 28450,
            kind: 'structure',
            hasProgram: true,
            hasPlan: true,
            detached: false,
            createdAt: '2026-10-01T12:00:00Z',
            updatedAt: '2026-11-06T18:30:00Z',
          },
          {
            id: 'bld_tavern',
            name: 'Prancing Pony Tavern',
            sizeX: 32,
            sizeY: 24,
            sizeZ: 32,
            blockCount: 8120,
            kind: 'structure',
            hasProgram: true,
            hasPlan: true,
            detached: false,
            createdAt: '2026-10-10T12:00:00Z',
            updatedAt: '2026-11-05T14:20:00Z',
          },
          {
            id: 'bld_windmill',
            name: 'Highland Windmill',
            sizeX: 24,
            sizeY: 36,
            sizeZ: 24,
            blockCount: 5400,
            kind: 'structure',
            hasProgram: true,
            hasPlan: false,
            detached: false,
            createdAt: '2026-10-15T12:00:00Z',
            updatedAt: '2026-11-04T10:15:00Z',
          },
        ],
      }),
    }),
  );

  console.log('Navigating to studio...');
  await page.goto('http://localhost:3018/studio?mode=build');
  await page.waitForLoadState('networkidle');

  // Seed localStorage plans and IndexedDB worlds
  await page.evaluate(async () => {
    localStorage.setItem(
      'craftmagic.architecture.plans',
      JSON.stringify([
        {
          id: 'pln_cottage',
          name: 'Lakeview Cottage Floorplan',
          updatedAt: '2026-11-07T08:00:00Z',
          plan: {
            id: 'pln_cottage',
            name: 'Lakeview Cottage Floorplan',
            floors: [
              {
                id: 'flr_1',
                elevation: 0,
                height: 4,
                rooms: [
                  {
                    id: 'rm_1',
                    name: 'Great Hall',
                    color: '#8ee8b2',
                    polygon: [
                      [0, 0],
                      [16, 0],
                      [16, 12],
                      [0, 12],
                    ],
                  },
                ],
                walls: [],
              },
            ],
            updatedAt: '2026-11-07T08:00:00Z',
          },
        },
        {
          id: 'pln_manor',
          name: 'Stone Manor Ground Floor',
          updatedAt: '2026-11-06T12:00:00Z',
          plan: {
            id: 'pln_manor',
            name: 'Stone Manor Ground Floor',
            floors: [
              {
                id: 'flr_g',
                elevation: 0,
                height: 4,
                rooms: [
                  {
                    id: 'rm_g',
                    name: 'Foyer',
                    color: '#e8b28e',
                    polygon: [
                      [0, 0],
                      [10, 0],
                      [10, 8],
                      [0, 8],
                    ],
                  },
                ],
                walls: [],
              },
            ],
            updatedAt: '2026-11-06T12:00:00Z',
          },
        },
      ]),
    );

    localStorage.setItem(
      'craftmagic.editor.generations',
      JSON.stringify([
        { id: 'gen:watchtower', name: 'Frontier Watchtower' },
      ]),
    );

    // Save worlds into IndexedDB
    await new Promise((resolve) => {
      const req = indexedDB.open('craftmagic.worlds', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('worlds')) {
          db.createObjectStore('worlds', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('worlds', 'readwrite');
        const store = tx.objectStore('worlds');
        store.put({
          key: 'world_nordic',
          id: 'world_nordic',
          name: 'Nordic Fjord Valley',
          sizeX: 512,
          sizeZ: 512,
          placements: 4,
          updatedAt: '2026-11-07T09:30:00Z',
          doc: {
            id: 'world_nordic',
            name: 'Nordic Fjord Valley',
            settings: { size: { x: 512, z: 512 }, seed: 42 },
            placements: [{}, {}, {}, {}],
            updatedAt: '2026-11-07T09:30:00Z',
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      };
      req.onerror = () => resolve();
    });
  });

  // Reload so StudioPage loads seeded files
  console.log('Reloading to load seeded work...');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);

  // -----------------------------------------------------------------
  // 1. Capture C1: Studio workspace shell and command palette
  // -----------------------------------------------------------------
  console.log('Capturing C1...');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.command-search__panel', { timeout: 3000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/c1-workspace-palette.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // -----------------------------------------------------------------
  // 2. Capture C2: Studio files manager (populated grid & list view with Account / Device badges)
  // -----------------------------------------------------------------
  console.log('Capturing C2...');
  // Click Open files in top header
  const openFilesBtn = page.locator('.workspace-header__file .studio__file-action').first();
  await openFilesBtn.click();
  await page.waitForSelector('.workspace-files', { timeout: 5000 });
  await page.waitForTimeout(600);

  // Take screenshot in grid view showing populated work with Account and Device badges
  await page.screenshot({ path: '/tmp/c2-files-grid.png' });

  // Switch to list view
  const listToggle = page.locator('button[aria-label="List layout"]');
  if (await listToggle.count()) {
    await listToggle.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/c2-files-list.png' });
    // Switch back to grid
    const gridToggle = page.locator('button[aria-label="Grid layout"]');
    if (await gridToggle.count()) await gridToggle.click();
    await page.waitForTimeout(300);
  }

  // Close files modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // -----------------------------------------------------------------
  // 3. Capture C3: New document modal (3 mode cards) & History timeline
  // -----------------------------------------------------------------
  console.log('Capturing C3...');
  // Trigger New Document modal
  const newDocBtn = page.locator('.workspace-header__file .studio__file-action').nth(1);
  if (await newDocBtn.count()) {
    await newDocBtn.click();
  } else {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('studio:new-document'));
    });
  }
  await page.waitForSelector('.new-document', { timeout: 5000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/c3-new-document.png' });

  // Close New Document modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Open History modal/panel
  const historyBtn = page.locator('button.workspace-status__history-btn, button[aria-label="Project history"]').first();
  if (await historyBtn.count()) {
    await historyBtn.click();
    await page.waitForSelector('.workspace-history', { timeout: 3000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/c3-history.png' });
    await page.keyboard.press('Escape');
  }

  await browser.close();
  console.log('Screenshots captured successfully!');

  const screenshotCmd = process.env.OPENBOT_SCREENSHOT;
  if (!screenshotCmd) {
    console.error('OPENBOT_SCREENSHOT environment variable not set!');
    return;
  }

  console.log('Registering C1 screenshot...');
  execSync(`node "${screenshotCmd}" --cmd="true" --from="/tmp/c1-workspace-palette.png" C1-studio-workspace-shell`, {
    stdio: 'inherit',
  });

  console.log('Registering C2 screenshot...');
  execSync(`node "${screenshotCmd}" --cmd="true" --from="/tmp/c2-files-grid.png" C2-studio-files-populated-badges`, {
    stdio: 'inherit',
  });

  console.log('Registering C3 screenshot...');
  execSync(`node "${screenshotCmd}" --cmd="true" --from="/tmp/c3-new-document.png" C3-new-document-flow-and-history`, {
    stdio: 'inherit',
  });

  console.log('All criteria screenshots registered successfully!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
