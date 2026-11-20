import { describe, expect, it } from 'vitest';

import {
  CLIPBOARD_IMAGE_SLIM_MAX_EDGE_PX,
  CLIPBOARD_IMAGE_SLIM_MIN_BYTES,
  computeMaxEdgeDimensions,
  hasAnimatedRasterHeader,
  hasOpaqueAlphaChannel,
  isCandidateForClipboardSlimming,
  replaceImageExtension,
} from '../../../src/runtime/chat/clipboard-image-slim';

describe('clipboard-image-slim pure invariants', () => {
  it('gates slimming strictly on static raster images larger than 4 MiB', () => {
    const exactBoundary = new File([new Uint8Array(CLIPBOARD_IMAGE_SLIM_MIN_BYTES)], 'shot.png', {
      type: 'image/png',
    });
    const overBoundary = new File([new Uint8Array(CLIPBOARD_IMAGE_SLIM_MIN_BYTES + 1)], 'shot.png', {
      type: 'image/png',
    });
    const gifFile = new File([new Uint8Array(CLIPBOARD_IMAGE_SLIM_MIN_BYTES + 100)], 'anim.gif', {
      type: 'image/gif',
    });
    const svgFile = new File([new Uint8Array(CLIPBOARD_IMAGE_SLIM_MIN_BYTES + 100)], 'vector.svg', {
      type: 'image/svg+xml',
    });
    const pdfFile = new File([new Uint8Array(CLIPBOARD_IMAGE_SLIM_MIN_BYTES + 100)], 'doc.pdf', {
      type: 'application/pdf',
    });

    expect(isCandidateForClipboardSlimming(exactBoundary)).toBe(false);
    expect(isCandidateForClipboardSlimming(overBoundary)).toBe(true);
    expect(isCandidateForClipboardSlimming(gifFile)).toBe(false);
    expect(isCandidateForClipboardSlimming(svgFile)).toBe(false);
    expect(isCandidateForClipboardSlimming(pdfFile)).toBe(false);
  });

  it('detects any transparent or semi-transparent pixel across the entire RGBA plane', () => {
    expect(hasOpaqueAlphaChannel(new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]))).toBe(true);
    expect(hasOpaqueAlphaChannel(new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 254]))).toBe(false);
    expect(hasOpaqueAlphaChannel(new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 255]))).toBe(false);
    expect(hasOpaqueAlphaChannel(new Uint8ClampedArray([]))).toBe(false);
  });

  it('recognises animated APNG (acTL) and animated WebP (VP8X) headers', () => {
    // Minimal PNG signature + IHDR (13B) + acTL (8B)
    const apng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 10, 0, 0, 0, 10, 8, 6, 0, 0, 0,
      0, 0, 0, 0,
      0x00, 0x00, 0x00, 0x08, 0x61, 0x63, 0x54, 0x4c,
      0, 0, 0, 2, 0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(hasAnimatedRasterHeader(apng)).toBe(true);

    // Static PNG signature + IHDR + IDAT
    const staticPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x04, 0x49, 0x44, 0x41, 0x54,
      1, 2, 3, 4, 0, 0, 0, 0,
    ]);
    expect(hasAnimatedRasterHeader(staticPng)).toBe(false);

    // Animated WebP VP8X with animation flag 0x02 at byte 20
    const animWebp = new Uint8Array(24);
    animWebp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 0);
    animWebp[20] = 0x02;
    expect(hasAnimatedRasterHeader(animWebp)).toBe(true);
    animWebp[20] = 0x10; // alpha only, not animated
    expect(hasAnimatedRasterHeader(animWebp)).toBe(false);
  });

  it('scales proportionally down to long edge ≤ 2560px and never upscales smaller images', () => {
    expect(computeMaxEdgeDimensions(4680, 2160, CLIPBOARD_IMAGE_SLIM_MAX_EDGE_PX)).toEqual({
      width: 2560,
      height: 1182,
      scaled: true,
    });
    expect(computeMaxEdgeDimensions(2160, 3840, CLIPBOARD_IMAGE_SLIM_MAX_EDGE_PX)).toEqual({
      width: 1440,
      height: 2560,
      scaled: true,
    });
    expect(computeMaxEdgeDimensions(1920, 1080, CLIPBOARD_IMAGE_SLIM_MAX_EDGE_PX)).toEqual({
      width: 1920,
      height: 1080,
      scaled: false,
    });
  });

  it('replaces image extension cleanly while preserving stem', () => {
    expect(replaceImageExtension('PixPin_2026-11-20.PNG', '.webp')).toBe('PixPin_2026-11-20.webp');
    expect(replaceImageExtension('screenshot', '.jpg')).toBe('screenshot.jpg');
  });
});
