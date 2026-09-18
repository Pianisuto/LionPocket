import { describe, expect, it } from 'vitest';
import { readPriorityVisibility, writePriorityVisibility } from './App';

describe('preferência de visibilidade das prioridades', () => {
  it('começa ativada e respeita o valor salvo', () => {
    expect(readPriorityVisibility({ getItem: () => null })).toBe(true);
    expect(readPriorityVisibility({ getItem: () => 'false' })).toBe(false);
  });

  it('informa quando não consegue persistir a escolha', () => {
    let saved = '';

    expect(writePriorityVisibility(false, { setItem: (_key, value) => { saved = value; } })).toBe(true);
    expect(saved).toBe('false');
    expect(writePriorityVisibility(false, { setItem: () => { throw new Error('indisponível'); } })).toBe(false);
  });
});
