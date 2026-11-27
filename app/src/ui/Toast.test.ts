import { TOAST_DURATION_MS, TOAST_ERROR_DURATION_MS, createToastStore, toastDuration, toastHaptic } from './Toast';

/** A fake clock for the store's timers. */
function fakeSchedule() {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return { cancel: () => void (t.live = false) };
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers) {
        if (t.live && t.at <= now) {
          t.live = false;
          t.fn();
        }
      }
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

describe('toast store', () => {
  it('shows one toast at a time: a new one replaces the old', () => {
    const clock = fakeSchedule();
    const store = createToastStore({ schedule: clock.schedule });
    store.show({ text: 'First' });
    const first = store.current()!;
    store.show({ text: 'Second', kind: 'success' });
    const second = store.current()!;
    expect(second.text).toBe('Second');
    expect(second.kind).toBe('success');
    expect(second.key).not.toBe(first.key);
    // Only the newest toast's timer is live.
    expect(clock.pending()).toBe(1);
  });

  it('dismisses itself after 2.4 s, errors after 4 s', () => {
    const clock = fakeSchedule();
    const store = createToastStore({ schedule: clock.schedule });
    store.show({ text: 'Saved' });
    clock.advance(TOAST_DURATION_MS - 1);
    expect(store.current()).not.toBeNull();
    clock.advance(1);
    expect(store.current()).toBeNull();

    store.error("Couldn't save");
    clock.advance(TOAST_DURATION_MS);
    expect(store.current()?.kind).toBe('error');
    clock.advance(TOAST_ERROR_DURATION_MS - TOAST_DURATION_MS);
    expect(store.current()).toBeNull();
  });

  it('keeps an offline toast until it is hidden by id', () => {
    const clock = fakeSchedule();
    const store = createToastStore({ schedule: clock.schedule });
    store.show({ id: 'offline', kind: 'offline', text: "You're offline." });
    clock.advance(60_000);
    expect(store.current()?.id).toBe('offline');
    store.hide('something-else');
    expect(store.current()?.id).toBe('offline');
    store.hide('offline');
    expect(store.current()).toBeNull();
  });

  it("a replaced toast's timer does not hide its successor", () => {
    const clock = fakeSchedule();
    const store = createToastStore({ schedule: clock.schedule });
    store.show({ text: 'One' });
    clock.advance(2000);
    store.show({ text: 'Two' });
    clock.advance(1000); // One's 2.4 s have passed
    expect(store.current()?.text).toBe('Two');
    clock.advance(TOAST_DURATION_MS);
    expect(store.current()).toBeNull();
  });

  it('tells subscribers and onShow', () => {
    const shown: string[] = [];
    const store = createToastStore({ schedule: fakeSchedule().schedule, onShow: (item) => shown.push(item.text) });
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.info('Hello');
    store.hide();
    off();
    store.info('Unheard');
    expect(calls).toBe(2);
    expect(shown).toEqual(['Hello', 'Unheard']);
  });
});

describe('toast rules', () => {
  it('durations per kind', () => {
    expect(toastDuration({ kind: 'info' })).toBe(2400);
    expect(toastDuration({ kind: 'success' })).toBe(2400);
    expect(toastDuration({ kind: 'error' })).toBe(4000);
    expect(toastDuration({ kind: 'offline' })).toBe(0);
    expect(toastDuration({ kind: 'info', duration: 1000 })).toBe(1000);
  });

  it('haptics as the brief maps them', () => {
    expect(toastHaptic({ kind: 'error' })).toBe('error');
    expect(toastHaptic({ kind: 'error', haptic: false })).toBeNull();
    expect(toastHaptic({ kind: 'success' })).toBeNull();
    expect(toastHaptic({ kind: 'success', haptic: true })).toBe('success');
    expect(toastHaptic({ kind: 'info', haptic: true })).toBeNull();
    expect(toastHaptic({})).toBeNull();
  });
});
