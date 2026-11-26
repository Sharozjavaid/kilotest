import type { Clock } from './motion';
import { ease, exitProgress, progress } from './motion';

/** Entrance and exit of a card that sits over the footage: a springy pop in, a quick lift out. */
export function cardEnvelope(c: Clock) {
  const pin = progress(c.t, 0, 0.42 * c.k);
  const pout = ease.inCubic(exitProgress(c, 0.24));
  const scaleIn = 0.62 + 0.38 * ease.outBack(pin, 1.55);
  return {
    scale: scaleIn * (1 - 0.1 * pout),
    opacity: Math.min(1, ease.outCubic(Math.min(1, pin * 3.2))) * (1 - pout),
    y: (1 - ease.outQuart(pin)) * 36 - pout * 34,
  };
}
