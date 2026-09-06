const fs = require('fs');
const rep = (p, pairs) => {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(p + ' missing: ' + a.slice(0, 130));
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
};

// --- send-to-game onto the binary path -------------------------------------------------------
rep('apps/web/src/agent/useAgents.ts', [
  [
    [
      '        grid: {',
      '          size: build.grid.size,',
      '          palette: build.grid.palette,',
      '          voxels: Array.from(build.grid.voxels),',
      '        },',
    ].join('\n'),
    [
      '        grid: {',
      '          size: build.grid.size,',
      '          palette: build.grid.palette,',
      '          // The same base64 ICVX blob "Save to library" has sent since the body-limit fix.',
      '          // This was still posting one JSON number per cell — 20 MB at the engine\'s own size',
      '          // cap against a 16 MB limit — so the stress-test sample saved fine and then 413\'d',
      '          // on send, from the same Export bar.',
      '          data: toBase64(encodeVoxels(build.grid)),',
      '        },',
    ].join('\n'),
  ],
]);

// --- the refusal reaches the user ------------------------------------------------------------
rep('apps/web/src/world/send.ts', [
  [
    [
      '  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string; error?: string };',
      '  if (!response.ok) {',
      '    throw new Error(body.message ?? body.error ?? `could not queue the region (HTTP ${response.status})`);',
      '  }',
      '  return { jobId: body.id ?? \'\', blocks: built.stats.blocks };',
    ].join('\n'),
    [
      '  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string; error?: string };',
      '  if (!response.ok) {',
      '    // The server distinguishes a refusal from a queue now, and its own words are the ones',
      '    // worth showing: "over the ceiling" and "region 0 has not said where it landed" are',
      '    // different problems with different answers, and both are things the user can act on.',
      '    throw new Error(body.message ?? body.error ?? `could not queue the region (HTTP ${response.status})`);',
      '  }',
      '  return { jobId: body.id ?? \'\', blocks: built.stats.blocks };',
    ].join('\n'),
  ],
]);

console.log('client side updated');
