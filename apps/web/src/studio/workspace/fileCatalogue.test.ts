import { describe, it, expect } from 'vitest';
import { catalogue, filterFiles, validateFileName } from './fileCatalogue.js';
const files = catalogue({
  builds: [],
  maps: [
    {
      id: 'm',
      name: 'Forest world',
      sizeX: 64,
      sizeZ: 64,
      placements: 2,
      updatedAt: '2026-01-01',
    },
  ],
  plans: [],
  localBuilds: [
    { id: 'gen:1', name: 'Stone keep' },
    { id: 'gen:2', name: 'Oak home' },
  ],
  signedIn: false,
});
describe('file catalogue', () => {
  it('uses stable typed keys and canonical routes', () => {
    expect(files[0]!.key).toBe('map:m');
    expect(files[0]!.href).toBe('/studio?mode=world&world=m');
  });
  it('filters by kind and storage without confusing local with cloud saves', () => {
    expect(filterFiles(files, '', 'builds', 'name')).toHaveLength(2);
    expect(filterFiles(files, '', 'account', 'name')).toHaveLength(0);
    expect(filterFiles(files, '', 'device', 'name')).toHaveLength(3);
  });
  it('sorts unknown dates safely and matches multiple words', () => {
    expect(filterFiles(files, '', 'all', 'recent')[0]!.id).toBe('m');
    expect(filterFiles(files, 'stone keep', 'all', 'name')).toHaveLength(1);
  });
  it.each(['', '   ', 'x'.repeat(121), 'hello\nworld'])(
    'rejects invalid name',
    (name) => expect(validateFileName(name)).not.toBeNull(),
  );
  it('allows Unicode names and punctuation', () =>
    expect(validateFileName(' Ægir’s keep 🏰 ')).toBeNull());
});

it('keeps device maps labelled local after account sign-in', () => {
  const result = catalogue({
    builds: [],
    plans: [],
    localBuilds: [],
    signedIn: true,
    maps: [
      {
        id: 'local-map',
        name: 'Local',
        sizeX: 32,
        sizeZ: 32,
        placements: 0,
        updatedAt: '2026-01-01',
        storage: 'device',
      },
    ],
  });
  expect(result[0]?.storage).toBe('device');
  expect(filterFiles(result, '', 'account', 'name')).toHaveLength(0);
});
