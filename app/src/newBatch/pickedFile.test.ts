import { contentTypeFromName, toPickedFile } from './pickedFile';

describe('picker assets to picked files', () => {
  it('reads duration as seconds on web and milliseconds on device', () => {
    const asset = { uri: 'blob:x', type: 'video', mimeType: 'video/mp4', fileName: 'clip1.mp4', fileSize: 1234, duration: 21.5 };
    expect(toPickedFile(asset, 0, { platform: 'web' }).durationSec).toBe(21.5);
    expect(toPickedFile({ ...asset, duration: 21500 }, 0, { platform: 'ios' }).durationSec).toBe(21.5);
  });

  it('uses the exact size from the picker, the web File, or the file on disk', () => {
    expect(toPickedFile({ uri: 'a', fileSize: 538098, fileName: 'a.mp4' }, 0, { platform: 'ios' }).sizeBytes).toBe(538098);
    expect(toPickedFile({ uri: 'b', file: { size: 38514, type: 'image/jpeg', name: 'p.jpg' } }, 0, { platform: 'web' }).sizeBytes).toBe(38514);
    expect(toPickedFile({ uri: 'file:///c.mov', fileName: 'c.mov' }, 0, { platform: 'android', sizeOf: () => 99 }).sizeBytes).toBe(99);
    expect(toPickedFile({ uri: 'file:///d.mov', fileName: 'd.mov' }, 0, { platform: 'android', sizeOf: () => null }).sizeBytes).toBe(0);
  });

  it('infers the content type from the name when the picker gives none', () => {
    const f = toPickedFile({ uri: 'file:///x', fileName: 'IMG_0042.MOV', type: 'video' }, 0, { platform: 'ios' });
    expect(f.contentType).toBe('video/quicktime');
    expect(f.kind).toBe('video');
    expect(toPickedFile({ uri: 'file:///y', fileName: 'shelf.webm' }, 0, { platform: 'android' }).kind).toBe('video');
    expect(contentTypeFromName('photo.HEIC')).toBe('image/heic');
    expect(contentTypeFromName('notes')).toBeNull();
  });

  it('names files the picker left unnamed', () => {
    expect(toPickedFile({ uri: 'ph://1', type: 'video' }, 2, { platform: 'ios' }).filename).toBe('clip-3.mov');
    expect(toPickedFile({ uri: 'ph://2', type: 'image' }, 0, { platform: 'ios' }).filename).toBe('photo-1.jpg');
  });
});
