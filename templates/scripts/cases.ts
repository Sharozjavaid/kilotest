import type { TemplateId } from '@kilo/edl';

export interface PreviewCase {
  name: string;
  theme: 'clean' | 'ink' | 'pop';
  props: Record<string, unknown>;
  durationSec?: number;
}

/** Edge cases: the longest and shortest text each schema allows, and the optional-field variants. */
export const PREVIEW_CASES: Record<TemplateId, PreviewCase[]> = {
  'bold-title': [
    { name: 'longest (60 chars)', theme: 'ink', props: { text: 'The one skincare mistake that nobody ever tells you about it' } },
    { name: 'shortest', theme: 'pop', props: { text: 'No' } },
    { name: 'long single word', theme: 'clean', props: { text: 'Unbelievably' } },
    { name: '60-char single word, min duration', theme: 'pop', props: { text: 'Pneumonoultramicroscopicsilicovolcanoconiosisxxxxxxxxxxxxxxx' }, durationSec: 1.0 },
  ],
  'numbered-list': [
    {
      name: 'longest: 5 items x 40 chars, 40-char title',
      theme: 'ink',
      props: {
        title: 'Five things I wish I knew before I start',
        items: [
          'Always patch test new products overnight',
          'Use less product than you think you need',
          'Apply thinnest to thickest every morning',
          'Never skip sunscreen, even when cloudy..',
          'Give every new routine at least 4 weeks.',
        ],
      },
      durationSec: 6,
    },
    { name: 'shortest: 2 items, no title, min duration', theme: 'pop', props: { items: ['Yes', 'No'] }, durationSec: 2 },
    { name: 'long single-word items', theme: 'clean', props: { title: 'Ingredients', items: ['Niacinamide', 'Hyaluronic', 'Ceramides'] } },
  ],
  'stat-callout': [
    { name: 'longest: 10-char value, 50-char label', theme: 'ink', props: { value: '$1,250,000', label: 'in sales from one single video posted last month!!' } },
    { name: 'shortest', theme: 'pop', props: { value: '3', label: 'x' }, durationSec: 1.2 },
    { name: 'decimal + suffix', theme: 'clean', props: { value: '4.9/5', label: 'average rating from 12,000 reviews' } },
  ],
  'keyword-pop': [
    { name: 'longest: 4 x 18 chars', theme: 'ink', props: { words: ['Extraordinarily!!!', 'Incomprehensibly!!', 'Transformations!!!', 'Uncharacteristic!!'] } },
    { name: 'shortest: one 1-char word, min duration', theme: 'pop', props: { words: ['A'] }, durationSec: 0.8 },
    { name: 'four short words', theme: 'clean', props: { words: ['this', 'actually', 'really', 'works'] } },
    { name: 'one 18-char word', theme: 'clean', props: { words: ['Hyperpigmentation!'] } },
  ],
  'price-tag': [
    { name: 'longest: 12-char prices, 40-char label', theme: 'ink', props: { price: '1.299,99 EUR', compareAt: '2.499,99 EUR', label: 'Black Friday only, while stocks last!!!!' } },
    { name: 'price only', theme: 'pop', props: { price: '$9' }, durationSec: 1.2 },
    { name: 'price + label, no compareAt', theme: 'clean', props: { price: '$49.99', label: 'Free shipping' } },
    { name: 'price + compareAt, no label', theme: 'pop', props: { price: '€19', compareAt: '€34' } },
  ],
};
