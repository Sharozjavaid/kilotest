import { TEMPLATES, TemplatePropsSchemas } from '@kilo/edl';
import { TEMPLATE_FIELDS, charsLeft, fitText, formFromProps, limitText, prefillProps, propsFromForm } from './templateForms';

describe('template fields', () => {
  it('reads limits from the contract schemas', () => {
    expect(TEMPLATE_FIELDS['bold-title']).toEqual([{ key: 'text', label: 'Text', kind: 'text', required: true, minLength: 1, maxLength: 60 }]);
    const list = TEMPLATE_FIELDS['numbered-list'];
    expect(list.map((f) => [f.key, f.required])).toEqual([['title', false], ['items', true]]);
    expect(list[1]).toMatchObject({ kind: 'list', minItems: 2, maxItems: 5, maxLength: 40 });
    expect(TEMPLATE_FIELDS['keyword-pop'][0]).toMatchObject({ minItems: 1, maxItems: 4, maxLength: 18 });
    expect(TEMPLATE_FIELDS['price-tag'].map((f) => f.key)).toEqual(['price', 'compareAt', 'label']);
  });

  it('describes the limits for the form', () => {
    expect(limitText(TEMPLATE_FIELDS['bold-title'][0]!)).toBe('Up to 60 characters');
    expect(limitText(TEMPLATE_FIELDS['numbered-list'][1]!)).toBe('2 to 5 items, up to 40 characters each');
    expect(limitText(TEMPLATE_FIELDS['price-tag'][1]!)).toBe('Optional, up to 12 characters');
    expect(charsLeft(TEMPLATE_FIELDS['bold-title'][0]!, 'Hello')).toBe(55);
  });
});

describe('form to props', () => {
  it('round-trips every template example', () => {
    for (const t of TEMPLATES) {
      const form = formFromProps(t.id, t.example);
      const r = propsFromForm(t.id, form);
      expect(r).toEqual({ ok: true, props: t.example });
    }
  });

  it('trims, drops empty optional fields and empty list items', () => {
    const r = propsFromForm('price-tag', { price: ' $19 ', compareAt: '', label: '  ' });
    expect(r).toEqual({ ok: true, props: { price: '$19' } });
    const l = propsFromForm('numbered-list', { title: '', items: ['One', ' ', 'Two '] });
    expect(l).toEqual({ ok: true, props: { items: ['One', 'Two'] } });
  });

  it('reports a friendly error per field', () => {
    const r = propsFromForm('bold-title', { text: 'x'.repeat(61) });
    expect(r).toEqual({ ok: false, errors: { text: 'Up to 60 characters' } });
    const e = propsFromForm('stat-callout', { value: '', label: 'ok' });
    expect(e).toEqual({ ok: false, errors: { value: 'Number is needed' } });
    const few = propsFromForm('numbered-list', { title: '', items: ['Only one'] });
    expect(few).toEqual({ ok: false, errors: { items: 'Add at least 2 items' } });
    const long = propsFromForm('keyword-pop', { words: ['fine', 'supercalifragilistic'] });
    expect(long).toEqual({ ok: false, errors: { words: 'Up to 18 characters each' } });
  });
});

describe('prefill from the spoken line', () => {
  const lines = [
    "Here's what nobody tells you about it.",
    "Okay, I've used this every morning for two weeks.",
    'It takes ten seconds and it actually works.',
    "Link's below if you want to try it.",
    'It was $34, today it is $19.',
    'Wash, tone, moisturise and then sunscreen.',
    'Hi.',
    '',
  ];
  it('always gives props the template accepts', () => {
    for (const t of TEMPLATES) {
      for (const line of lines) {
        const props = prefillProps(t.id, line);
        expect(TemplatePropsSchemas[t.id].safeParse(props).success).toBe(true);
      }
    }
  });

  it('pulls the useful parts out of the line', () => {
    expect(prefillProps('bold-title', "Here's what nobody tells you about it.")).toEqual({ text: "Here's what nobody tells you about it" });
    expect(prefillProps('stat-callout', 'It takes ten seconds and it actually works.')).toEqual({ value: '10 seconds', label: 'and it actually works' });
    expect(prefillProps('price-tag', 'It was $34, today it is $19.')).toEqual({ price: '$34', compareAt: '$19' });
    expect(prefillProps('numbered-list', 'Wash, tone, moisturise and then sunscreen.')).toEqual({ items: ['Wash', 'tone', 'moisturise', 'sunscreen'] });
    expect(prefillProps('keyword-pop', "Here's what nobody tells you about it.")).toEqual({ words: ['nobody', 'tells'] });
  });

  it('cuts long text at a word boundary', () => {
    expect(fitText('one two three four', 9)).toBe('one two');
  });
});
