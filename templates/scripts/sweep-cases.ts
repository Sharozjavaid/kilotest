import type { TemplateId } from '@kilo/edl';
import { TemplatePropsSchemas } from '@kilo/edl';

/**
 * The text cases of the Phase 4 sweep: every template gets each kind of text, at the
 * limits its props schema allows. `covered` says whether the bundled Inter is meant to
 * draw every character (false for emoji and scripts Inter does not have).
 */
export interface SweepCase {
  kind: string;
  covered: boolean;
  props: Record<string, unknown>;
}

export const CASE_KINDS = [
  'shortest', 'typical', 'schema maximum', 'long unbroken word', 'all capitals', 'digits and currency', 'accented Latin',
  'Cyrillic (covered)', 'emoji', 'Japanese (not covered)', 'Arabic (not covered)',
] as const;

const W60 = 'Pneumonoultramicroscopicsilicovolcanoconiosisantidisestabli'; // 60 letters, one word
const W40 = W60.slice(0, 40);
const W50 = W60.slice(0, 50);
const W18 = W60.slice(0, 18);

export const SWEEP_CASES: Record<TemplateId, SweepCase[]> = {
  'bold-title': [
    { kind: 'shortest', covered: true, props: { text: 'A' } },
    { kind: 'typical', covered: true, props: { text: 'Nobody tells you this' } },
    { kind: 'schema maximum', covered: true, props: { text: 'The one skincare mistake that nobody ever tells you about it' } },
    { kind: 'long unbroken word', covered: true, props: { text: W60 } },
    { kind: 'all capitals', covered: true, props: { text: 'THE ONE SKINCARE MISTAKE THAT NOBODY EVER TELLS YOU ABOUT IT' } },
    { kind: 'digits and currency', covered: true, props: { text: '$1,299.99 now €999, £850 or ¥120,000: 50% off 24/7' } },
    { kind: 'accented Latin', covered: true, props: { text: 'Crème brûlée à São Paulo: Łódź, Øresund, Ålesund, naïve' } },
    { kind: 'Cyrillic (covered)', covered: true, props: { text: 'Этот крем изменил мою кожу за одну неделю' } },
    { kind: 'emoji', covered: false, props: { text: 'This changed my skin 🔥😍✨ in a week 👏🏽' } },
    { kind: 'Japanese (not covered)', covered: false, props: { text: 'この化粧水は本当に一週間で肌が変わりました' } },
    { kind: 'Arabic (not covered)', covered: false, props: { text: 'هذا المنتج غير بشرتي في أسبوع واحد فقط' } },
  ],
  'numbered-list': [
    { kind: 'shortest', covered: true, props: { items: ['A', 'B'] } },
    { kind: 'typical', covered: true, props: { title: 'Three mistakes', items: ['Too much product', 'Wrong order', 'Skipping SPF'] } },
    {
      kind: 'schema maximum', covered: true, props: {
        title: 'Five things I wish I knew before I start',
        items: ['Always patch test new products overnight', 'Use less product than you think you need', 'Apply thinnest to thickest every morning', 'Never skip sunscreen, even when cloudy..', 'Give every new routine at least 4 weeks.'],
      },
    },
    { kind: 'long unbroken word', covered: true, props: { title: W40, items: [W40, W40, W40, W40, W40] } },
    {
      kind: 'all capitals', covered: true, props: {
        title: 'FIVE THINGS I WISH I KNEW BEFORE I START',
        items: ['ALWAYS PATCH TEST NEW PRODUCTS OVERNIGHT', 'USE LESS PRODUCT THAN YOU THINK YOU NEED', 'APPLY THINNEST TO THICKEST EVERY MORNING', 'NEVER SKIP SUNSCREEN, EVEN WHEN CLOUDY!!', 'GIVE EVERY NEW ROUTINE AT LEAST 4 WEEKS.'],
      },
    },
    { kind: 'digits and currency', covered: true, props: { title: 'Prices in 2025: $, €, £, ¥', items: ['$19.99 → $9.99 (50% off)', '€1.299,00 per 12 months', '£0.99/day, 365 days', '¥120,000 or 3 × ¥40,000'] } },
    { kind: 'accented Latin', covered: true, props: { title: 'Três passos fáceis', items: ['Limpe o rosto às sete', 'Hydratation légère, crème', 'Sérum à la vitamine C', 'Ochrona przeciwsłoneczna'] } },
    { kind: 'Cyrillic (covered)', covered: true, props: { title: 'Три ошибки', items: ['Слишком много крема', 'Неправильный порядок', 'Без защиты от солнца'] } },
    { kind: 'emoji', covered: false, props: { title: 'My routine ✨', items: ['Cleanse 🧼', 'Serum 💧', 'SPF ☀️ every day'] } },
    { kind: 'Japanese (not covered)', covered: false, props: { title: '三つの間違い', items: ['クリームを塗りすぎる', '順番が間違っている', '日焼け止めを忘れる'] } },
    { kind: 'Arabic (not covered)', covered: false, props: { title: 'ثلاثة أخطاء', items: ['كمية كبيرة من الكريم', 'ترتيب خاطئ للمنتجات', 'نسيان واقي الشمس'] } },
  ],
  'stat-callout': [
    { kind: 'shortest', covered: true, props: { value: '3', label: 'x' } },
    { kind: 'typical', covered: true, props: { value: '10 sec', label: 'is all it takes' } },
    { kind: 'schema maximum', covered: true, props: { value: '1,250,000+', label: 'people bought one after seeing this single video' } },
    { kind: 'long unbroken word', covered: true, props: { value: 'Incredible', label: W50 } },
    { kind: 'all capitals', covered: true, props: { value: 'TEN TIMES!', label: 'PEOPLE BOUGHT ONE AFTER SEEING THIS SINGLE VIDEO' } },
    { kind: 'digits and currency', covered: true, props: { value: '$1,299.99', label: '€1.099 · £999 · ¥149,800 · 30% cheaper' } },
    { kind: 'accented Latin', covered: true, props: { value: '97 %', label: 'des clientes ont vu leur peau s’améliorer, Łódź' } },
    { kind: 'Cyrillic (covered)', covered: true, props: { value: '90%', label: 'людей пропускают этот шаг каждое утро' } },
    { kind: 'emoji', covered: false, props: { value: '10x 🔥', label: 'more glow in one week ✨😍' } },
    { kind: 'Japanese (not covered)', covered: false, props: { value: '90%', label: 'の人がこのステップを毎朝飛ばしています' } },
    { kind: 'Arabic (not covered)', covered: false, props: { value: '٪٩٠', label: 'من الناس يتخطون هذه الخطوة كل صباح' } },
  ],
  'keyword-pop': [
    { kind: 'shortest', covered: true, props: { words: ['A'] } },
    { kind: 'typical', covered: true, props: { words: ['actually', 'works'] } },
    { kind: 'schema maximum', covered: true, props: { words: ['Extraordinarily!!!', 'Incomprehensibly!!', 'Transformations!!!', 'Uncharacteristic!!'] } },
    { kind: 'long unbroken word', covered: true, props: { words: [W18] } },
    { kind: 'all capitals', covered: true, props: { words: ['EXTRAORDINARILY!!!', 'INCOMPREHENSIBLY!!', 'TRANSFORMATIONS!!!', 'UNCHARACTERISTIC!!'] } },
    { kind: 'digits and currency', covered: true, props: { words: ['$1,299.99', '€999', '50%', '¥120,000'] } },
    { kind: 'accented Latin', covered: true, props: { words: ['Très', 'économique', 'façon', 'Ćwiczenie'] } },
    { kind: 'Cyrillic (covered)', covered: true, props: { words: ['Это', 'реально', 'работает'] } },
    { kind: 'emoji', covered: false, props: { words: ['🔥', 'Wow', '😍✨'] } },
    { kind: 'Japanese (not covered)', covered: false, props: { words: ['本当に', '効きます'] } },
    { kind: 'Arabic (not covered)', covered: false, props: { words: ['هذا', 'رائع', 'حقا'] } },
  ],
  'price-tag': [
    { kind: 'shortest', covered: true, props: { price: '$' } },
    { kind: 'typical', covered: true, props: { price: '$19', compareAt: '$34', label: 'Today only' } },
    { kind: 'schema maximum', covered: true, props: { price: '1.299,99 EUR', compareAt: '2.499,99 EUR', label: 'Black Friday only, while stocks last!!!!' } },
    { kind: 'long unbroken word', covered: true, props: { price: 'FREEFREEFREE', compareAt: '$1234567890', label: W40 } },
    { kind: 'all capitals', covered: true, props: { price: 'FREE TODAY', compareAt: 'WAS $34.99', label: 'BLACK FRIDAY ONLY, WHILE STOCKS LAST!!!!' } },
    { kind: 'digits and currency', covered: true, props: { price: '¥120,000', compareAt: '£2,499.00', label: '€1.299,99 · 20% off until 31/12' } },
    { kind: 'accented Latin', covered: true, props: { price: '19,99 €', compareAt: '34,99 €', label: 'Livraison gratuite, dès aujourd’hui' } },
    { kind: 'Cyrillic (covered)', covered: true, props: { price: '990 ₽', compareAt: '1 990 ₽', label: 'Только сегодня' } },
    { kind: 'emoji', covered: false, props: { price: '$19 🔥', compareAt: '$34', label: 'Today only ⏰✨' } },
    { kind: 'Japanese (not covered)', covered: false, props: { price: '¥1,980', compareAt: '¥3,480', label: '本日限定セール' } },
    { kind: 'Arabic (not covered)', covered: false, props: { price: '٩٩ ر.س', compareAt: '١٩٩ ر.س', label: 'عرض اليوم فقط' } },
  ],
};

/** Throws when a case does not satisfy its template's props schema. */
export function assertCasesValid(): void {
  for (const [id, cases] of Object.entries(SWEEP_CASES) as Array<[TemplateId, SweepCase[]]>) {
    for (const c of cases) {
      const r = TemplatePropsSchemas[id].safeParse(c.props);
      if (!r.success) throw new Error(`${id} "${c.kind}": ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const kinds = cases.map((c) => c.kind);
    for (const k of CASE_KINDS) if (!kinds.includes(k)) throw new Error(`${id} has no "${k}" case`);
  }
}
