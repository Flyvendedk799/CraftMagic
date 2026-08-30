const fs = require('fs');
const rep = (p, pairs) => {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(p + ' missing: ' + a.slice(0, 90));
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
};

// --- WorldMap: Place drops the armed component where you click ---------------------------
rep('apps/web/src/world/WorldMap.tsx', [
  [
    '  /** Where an edit gesture landed, so the 3D check can follow the work. */\n  onEdited: (x: number, z: number) => void;',
    [
      '  /** Where an edit gesture landed, so the 3D check can follow the work. */',
      '  onEdited: (x: number, z: number) => void;',
      '  /** A click with the Place tool, in world columns. */',
      '  onPlaceAt: (x: number, z: number) => void;',
    ].join('\n'),
  ],
  [
    [
      "      if (tool === 'carve') {",
      '        drag.current = { kind: \'carve\', cells: [world], lastX: world.x, lastZ: world.z };',
      '        host.setPointerCapture(event.pointerId);',
      '        return;',
      '      }',
    ].join('\n'),
    [
      "      if (tool === 'place') {",
      '        // A click, not a drag: a building is dropped where you point rather than painted',
      '        // along a stroke. Falling through to the terrain path — which is what happened',
      '        // before this branch existed — ran a brush whose tool matched none of the write',
      '        // cases, so Place noted a few hundred columns, changed nothing, and discarded the',
      '        // empty stroke. It looked exactly like a dead button, which it was.',
      '        props.onPlaceAt(world.x, world.z);',
      '        return;',
      '      }',
      '',
      "      if (tool === 'carve') {",
      '        drag.current = { kind: \'carve\', cells: [world], lastX: world.x, lastZ: world.z };',
      '        capture(host, event.pointerId);',
      '        return;',
      '      }',
    ].join('\n'),
  ],
]);

// --- WorldPage: arm a component, then drop copies of it ------------------------------------
rep('apps/web/src/world/WorldPage.tsx', [
  [
    '  const [sculpting, setSculpting] = useState(false);',
    [
      '  const [sculpting, setSculpting] = useState(false);',
      '  /**',
      '   * The component the Place tool will drop next.',
      '   *',
      '   * Picking one from the shelf arms it and switches to Place, so putting forty lamps down a',
      '   * street is forty clicks rather than forty round trips to the shelf. It stays armed until',
      '   * something else is picked, which is what makes a hub buildable at all.',
      '   */',
      '  const [armed, setArmed] = useState<ShelfEntry | null>(null);',
    ].join('\n'),
  ],
  [
    [
      '  const addComponent = useCallback(',
      '    (entry: ShelfEntry) => {',
      '      // Dropped at the middle of the plot rather than at 0,0 — a component that lands in the',
      '      // corner of a 1024² map is off screen, and reads as a click that did nothing.',
      '      const placement: WorldPlacement = {',
      '        id: worldId(\'p\'),',
      '        buildId: entry.id,',
      '        x: Math.max(0, Math.round(doc.settings.size.x / 2 - entry.w / 2)),',
      '        z: Math.max(0, Math.round(doc.settings.size.z / 2 - entry.d / 2)),',
    ].join('\n'),
    [
      '  /** Drop a component, centred on a column. */',
      '  const placeAt = useCallback(',
      '    (entry: ShelfEntry, cx: number, cz: number) => {',
      '      const placement: WorldPlacement = {',
      '        id: worldId(\'p\'),',
      '        buildId: entry.id,',
      '        // Centred on the point rather than cornered at it: you aim a building at where you',
      '        // want it to stand, not at where its north-west corner should go.',
      '        x: Math.max(0, Math.min(doc.settings.size.x - 1, Math.round(cx - entry.w / 2))),',
      '        z: Math.max(0, Math.min(doc.settings.size.z - 1, Math.round(cz - entry.d / 2))),',
    ].join('\n'),
  ],
  [
    [
      '      session.commitPlacements([...doc.placements, placement]);',
      '      setSelected(placement.id);',
      '      void library.load(entry.id);',
      '    },',
      '    [doc, session, library],',
      '  );',
    ].join('\n'),
    [
      '      session.commitPlacements([...doc.placements, placement]);',
      '      setSelected(placement.id);',
      '      void library.load(entry.id);',
      '    },',
      '    [doc, session, library],',
      '  );',
      '',
      '  /** Picking from the shelf arms the component and hands the pointer the Place tool. */',
      '  const armComponent = useCallback((entry: ShelfEntry) => {',
      '    setArmed(entry);',
      "    setTool('place');",
      '  }, []);',
    ].join('\n'),
  ],
  [
    '            onAdd={addComponent}',
    '            onAdd={armComponent}',
  ],
  [
    '              onCarve={carve}',
    [
      '              onCarve={carve}',
      '              onPlaceAt={(x, z) => {',
      '                if (armed) placeAt(armed, x, z);',
      "                else setNotice('Pick a component on the right, then click the map to drop it.');",
      '              }}',
    ].join('\n'),
  ],
]);

// --- PlacementsPanel: say which one is armed -----------------------------------------------
rep('apps/web/src/world/PlacementsPanel.tsx', [
  [
    '  /** Add a component at the middle of the current view, or wherever the page decides. */\n  onAdd: (entry: ShelfEntry) => void;',
    [
      '  /** Arm a component for the Place tool. */',
      '  onAdd: (entry: ShelfEntry) => void;',
      '  /** Which one is armed, so the shelf shows what the next click will drop. */',
      '  armed?: string | null;',
    ].join('\n'),
  ],
  [
    '              <button type="button" className="shelf__item" onClick={() => props.onAdd(entry)}>',
    [
      '              <button',
      '                type="button"',
      '                className="shelf__item"',
      '                aria-pressed={props.armed === entry.id}',
      '                onClick={() => props.onAdd(entry)}',
      '              >',
    ].join('\n'),
  ],
  [
    '        {library.status === \'ready\' && shelf.length === 0 && (',
    [
      '        {props.armed && (',
      '          <p className="world__hint">Click the map to drop it. It stays armed for the next one.</p>',
      '        )}',
      '',
      '        {library.status === \'ready\' && shelf.length === 0 && (',
    ].join('\n'),
  ],
]);

console.log('patched');
