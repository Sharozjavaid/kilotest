import { Asset } from 'expo-asset';
import type { MockMedia } from './mockApi';

/**
 * Bundled media for mock mode: a real 540x960 proxy of the `routine` fixture
 * (assets/mock/proxy.mp4), a thumbnail and two B-roll stills.
 */
export function bundledMockMedia(): MockMedia {
  const uri = (mod: number) => Asset.fromModule(mod).uri;
  return {
    proxyUrl: uri(require('../../../assets/mock/proxy.mp4')),
    thumbnailUrl: uri(require('../../../assets/mock/thumb.jpg')),
    brollImageUrls: [uri(require('../../../assets/mock/broll-product.jpg')), uri(require('../../../assets/mock/broll-stopwatch.jpg'))],
  };
}
