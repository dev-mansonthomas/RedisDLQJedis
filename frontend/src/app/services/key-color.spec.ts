import { describe, expect, it } from 'vitest';

import { keyColor } from './key-color';

describe('keyColor', () => {
  it('keeps the six demo keys on the colours the page already used', () => {
    expect(keyColor('#1001')).toBe('#3b82f6');
    expect(keyColor('#2002')).toBe('#10b981');
    expect(keyColor('#3003')).toBe('#f59e0b');
    expect(keyColor('#4004')).toBe('#8b5cf6');
    expect(keyColor('#5005')).toBe('#ec4899');
    expect(keyColor('#6006')).toBe('#14b8a6');
  });

  it('falls back to slate for a key outside the palette', () => {
    // The grid still labels the cell, so two uncoloured keys stay distinguishable by text.
    expect(keyColor('#9999')).toBe('#64748b');
    expect(keyColor('')).toBe('#64748b');
  });
});
