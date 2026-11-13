import { describe, expect, it } from 'vitest';
import { greet } from './index.js';

describe('greet', () => {
  it('greets by name', () => {
    expect(greet('world')).toBe('Hello, world!');
  });

  it('supports loud mode', () => {
    expect(greet('world', { loud: true })).toBe('HELLO, WORLD!');
  });
});
