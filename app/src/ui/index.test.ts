// The whole design system loads under jest (native modules mocked by jest-expo and jest.setup.js),
// so screen tests can import from '@/ui'.
describe('@/ui', () => {
  it('loads', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ui = require('./index') as typeof import('./index');
    expect(typeof ui.PillButton).toBe('function');
    expect(typeof ui.Glass).toBe('function');
    expect(typeof ui.PressableScale).toBe('function');
    expect(ui.layoutMotion(false).listLayout).toBeDefined();
    expect(ui.layoutMotion(true).listLayout).toBeUndefined();
  });
});
