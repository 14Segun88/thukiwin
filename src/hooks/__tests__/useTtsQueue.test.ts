import { describe, it, expect } from 'vitest';
import { splitSentences } from '../useTtsQueue';

describe('splitSentences', () => {
  it('returns empty list and original remainder for fragments without a boundary', () => {
    const out = splitSentences('Привет, я ещё пишу');
    expect(out.sentences).toEqual([]);
    expect(out.remainder).toBe('Привет, я ещё пишу');
  });

  it('splits on a period followed by space', () => {
    const out = splitSentences('Первое предложение. Второе ');
    expect(out.sentences).toEqual(['Первое предложение.']);
    expect(out.remainder).toBe('Второе ');
  });

  it('splits on question and exclamation marks', () => {
    const out = splitSentences('Привет! Как дела? Я ');
    expect(out.sentences).toEqual(['Привет!', 'Как дела?']);
    expect(out.remainder).toBe('Я ');
  });

  it('treats double newline as a boundary', () => {
    const out = splitSentences('Параграф один\n\nПараграф два');
    expect(out.sentences).toEqual(['Параграф один']);
    expect(out.remainder).toBe('Параграф два');
  });

  it('keeps a single newline as part of the remainder', () => {
    const out = splitSentences('Строка один\nещё');
    expect(out.sentences).toEqual([]);
    expect(out.remainder).toBe('Строка один\nещё');
  });

  it('handles ellipsis and CJK punctuation', () => {
    const out = splitSentences('Подожди… Готово。 Дальше ');
    expect(out.sentences).toEqual(['Подожди…', 'Готово。']);
    expect(out.remainder).toBe('Дальше ');
  });

  it('force-flushes a very long fragment on whitespace', () => {
    const long = 'word '.repeat(80); // 400 chars, no terminal punctuation
    const out = splitSentences(long);
    expect(out.sentences.length).toBeGreaterThan(0);
    expect(out.remainder.length).toBeLessThanOrEqual(240);
  });

  it('handles closing quotes after terminal punctuation', () => {
    const out = splitSentences('Он сказал: «Привет!» И ушёл. ');
    expect(out.sentences).toEqual(['Он сказал: «Привет!»', 'И ушёл.']);
    expect(out.remainder).toBe('');
  });
});
