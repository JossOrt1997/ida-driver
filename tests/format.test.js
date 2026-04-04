const { sanitizePrintableText, stripResidualTags } = require('../lib/format');

describe('driver text formatting', () => {
  test('sanitizes escaped new lines and quotes', () => {
    const input = 'Linea1\\nLinea2\\"ok\\"';
    const out = sanitizePrintableText(input);
    expect(out.includes('\n')).toBe(true);
    expect(out.includes('"ok"')).toBe(true);
  });

  test('strips style tags from residual line', () => {
    const line = '[B][C]Hola[/C][/B]';
    expect(stripResidualTags(line)).toBe('Hola');
  });

  test('preserves special characters while removing style tags', () => {
    const input = 'Cafe con pinon, nandu, jalapeno y limon';
    const wrapped = `[C][B]${input}[/B][/C]`;
    expect(stripResidualTags(wrapped)).toBe(input);
  });
});
