/**
 * The base64 pair, tested on its own now that three codecs share it.
 *
 * Hand-rolled base64 goes wrong in exactly two places — the tail, where 1 or 2 leftover bytes
 * need different padding, and the high bit, where a byte over 127 becomes negative if anything
 * in the chain is signed. Both are silent: you get bytes back, just not the ones you sent.
 */

import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from './bytes.js';

const roundTrip = (bytes: number[]) => [...fromBase64(toBase64(Uint8Array.from(bytes)))];

describe('base64', () => {
  it('round-trips an empty array', () => {
    expect(toBase64(new Uint8Array(0))).toBe('');
    expect([...fromBase64('')]).toEqual([]);
  });

  it('round-trips every tail length', () => {
    // 3n, 3n+1, 3n+2 are the three padding cases.
    expect(roundTrip([1, 2, 3])).toEqual([1, 2, 3]);
    expect(roundTrip([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(roundTrip([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
  });

  it('round-trips every byte value', () => {
    const all = Array.from({ length: 256 }, (_, i) => i);
    expect(roundTrip(all)).toEqual(all);
  });

  it('pads the way base64 is supposed to', () => {
    expect(toBase64(Uint8Array.from([0]))).toBe('AA==');
    expect(toBase64(Uint8Array.from([0, 0]))).toBe('AAA=');
    expect(toBase64(Uint8Array.from([0, 0, 0]))).toBe('AAAA');
  });

  it('matches the platform encoder, so the bytes are really base64', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('decodes what the platform encoder produced', () => {
    const bytes = Uint8Array.from({ length: 257 }, (_, i) => (i * 91 + 7) % 256);
    const encoded = Buffer.from(bytes).toString('base64');
    expect([...fromBase64(encoded)]).toEqual([...bytes]);
  });

  it('skips whitespace and newlines rather than choking on them', () => {
    const bytes = Uint8Array.from([9, 8, 7, 6, 5]);
    const wrapped = toBase64(bytes).replace(/(.{4})/g, '$1\n');
    expect([...fromBase64(wrapped)]).toEqual([...bytes]);
  });

  it('survives a large buffer without truncating the tail', () => {
    const bytes = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 13) % 256);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});
