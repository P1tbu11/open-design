/**
 * Smart client-side slimming exclusivamente for clipboard-pasted large screenshots.
 *
 * Invariants:
 * 1. Non-paste sources (file picker, drag-and-drop, library, annotations) MUST
 *    never pass through this helper — workspace originals stay 100% lossless.
 * 2. Only static raster images larger than `CLIPBOARD_IMAGE_SLIM_MIN_BYTES`
 *    (4 MiB) are inspected; smaller files skip Canvas decoding completely.
 * 3. If ANY pixel has `alpha < 255` (transparent or semi-transparent UI/character
 *    layer), or if the image is animated (APNG / animated WebP / GIF), the
 *    original `File` instance is returned 100% untouched.
 * 4. Fully opaque screenshots are proportionally constrained to long edge
 *    ≤ `CLIPBOARD_IMAGE_SLIM_MAX_EDGE_PX` (2560px) and encoded as high-quality
 *    WebP (falling back to JPEG when WebP encoding is unavailable) at quality 0.90.
 */

export const CLIPBOARD_IMAGE_SLIM_MIN_BYTES = 4 * 1024 * 1024;
export const CLIPBOARD_IMAGE_SLIM_MAX_EDGE_PX = 2560;
export const CLIPBOARD_IMAGE_SLIM_QUALITY = 0.9;

const SLIMMABLE_MIME_TYPES = new Set([
  'image/png',
  'image/webp',
  'image/jpeg',
  'image/jpg',
  'image/bmp',
]);

const SLIMMABLE_EXT_RE = /\.(png|webp|jpe?g|bmp)$/i;

export interface ClipboardImageSlimOptions {
  minBytes?: number;
  maxEdgePx?: number;
  quality?: number;
}

export function isCandidateForClipboardSlimming(
  file: File,
  minBytes = CLIPBOARD_IMAGE_SLIM_MIN_BYTES,
): boolean {
  if (!file || !(file.size > minBytes)) return false;
  const mime = file.type.trim().toLowerCase();
  if (mime) {
    return SLIMMABLE_MIME_TYPES.has(mime);
  }
  return SLIMMABLE_EXT_RE.test(file.name);
}

/**
 * Detect animated PNG (`acTL` before `IDAT`) or animated WebP (`VP8X` animation bit)
 * from the leading file header bytes so animated clipboard assets are never flattened.
 */
export function hasAnimatedRasterHeader(header: Uint8Array): boolean {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    header.length >= 8
    && header[0] === 0x89
    && header[1] === 0x50
    && header[2] === 0x4e
    && header[3] === 0x47
    && header[4] === 0x0d
    && header[5] === 0x0a
    && header[6] === 0x1a
    && header[7] === 0x0a
  ) {
    let offset = 8;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    while (offset + 8 <= header.length) {
      const chunkLen = view.getUint32(offset, false);
      const c0 = header[offset + 4];
      const c1 = header[offset + 5];
      const c2 = header[offset + 6];
      const c3 = header[offset + 7];
      // 'acTL' = 0x61 0x63 0x54 0x4c
      if (c0 === 0x61 && c1 === 0x63 && c2 === 0x54 && c3 === 0x4c) {
        return true;
      }
      // 'IDAT' = 0x49 0x44 0x41 0x54, 'IEND' = 0x49 0x45 0x4e 0x44
      if (
        c0 === 0x49
        && ((c1 === 0x44 && c2 === 0x41 && c3 === 0x54) || (c1 === 0x45 && c2 === 0x4e && c3 === 0x44))
      ) {
        return false;
      }
      const next = offset + 12 + chunkLen;
      if (next <= offset) break;
      offset = next;
    }
    return false;
  }

  // RIFF....WEBP with VP8X chunk at offset 12
  if (
    header.length >= 21
    && header[0] === 0x52 // R
    && header[1] === 0x49 // I
    && header[2] === 0x46 // F
    && header[3] === 0x46 // F
    && header[8] === 0x57 // W
    && header[9] === 0x45 // E
    && header[10] === 0x42 // B
    && header[11] === 0x50 // P
    && header[12] === 0x56 // V
    && header[13] === 0x50 // P
    && header[14] === 0x38 // 8
    && header[15] === 0x58 // X
  ) {
    return ((header[20] ?? 0) & 0x02) !== 0;
  }

  return false;
}

/**
 * Returns `true` iff every pixel in the RGBA buffer is 100% opaque (`alpha === 255`).
 */
export function hasOpaqueAlphaChannel(rgba: ArrayLike<number>): boolean {
  const len = rgba.length;
  if (len === 0 || len % 4 !== 0) return false;
  for (let i = 3; i < len; i += 4) {
    if (rgba[i] !== 255) return false;
  }
  return true;
}

export function computeMaxEdgeDimensions(
  width: number,
  height: number,
  maxEdgePx = CLIPBOARD_IMAGE_SLIM_MAX_EDGE_PX,
): { width: number; height: number; scaled: boolean } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdgePx) {
    return { width, height, scaled: false };
  }
  const scale = maxEdgePx / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true,
  };
}

export function replaceImageExtension(fileName: string, nextExtension: '.webp' | '.jpg'): string {
  const trimmed = fileName.trim() || 'clipboard-screenshot';
  if (/\.[^./\\]+$/.test(trimmed)) {
    return trimmed.replace(/\.[^./\\]+$/, nextExtension);
  }
  return `${trimmed}${nextExtension}`;
}

type DecodedCanvasSource = {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
};

async function decodeImageForCanvas(file: File): Promise<DecodedCanvasSource | null> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      bitmap.close?.();
      return null;
    }
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close?.(),
    };
  }

  if (
    typeof Image === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
  ) {
    return null;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode clipboard image'));
      el.src = objectUrl;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width <= 0 || height <= 0) {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
    return {
      source: img,
      width,
      height,
      dispose: () => {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* ignore */
    }
    return null;
  }
}

function encodeCanvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mimeType, quality);
    } catch {
      resolve(null);
    }
  });
}

function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

export async function slimClipboardPasteFile(
  file: File,
  options: ClipboardImageSlimOptions = {},
): Promise<File> {
  const minBytes = options.minBytes ?? CLIPBOARD_IMAGE_SLIM_MIN_BYTES;
  const maxEdgePx = options.maxEdgePx ?? CLIPBOARD_IMAGE_SLIM_MAX_EDGE_PX;
  const quality = options.quality ?? CLIPBOARD_IMAGE_SLIM_QUALITY;

  if (!isCandidateForClipboardSlimming(file, minBytes)) {
    return file;
  }
  if (typeof document === 'undefined') {
    return file;
  }

  try {
    if (typeof file.slice === 'function') {
      const headChunk = file.slice(0, 4096);
      if (typeof headChunk.arrayBuffer === 'function') {
        const header = new Uint8Array(await headChunk.arrayBuffer());
        if (hasAnimatedRasterHeader(header)) {
          return file;
        }
      }
    }
  } catch {
    // Non-fatal in minimal environments; proceed to Canvas inspection.
  }

  let decoded: DecodedCanvasSource | null = null;
  let inspectCanvas: HTMLCanvasElement | null = null;
  let outputCanvas: HTMLCanvasElement | null = null;

  try {
    decoded = await decodeImageForCanvas(file);
    if (!decoded) return file;

    inspectCanvas = document.createElement('canvas');
    inspectCanvas.width = decoded.width;
    inspectCanvas.height = decoded.height;
    const inspectCtx = inspectCanvas.getContext('2d', { willReadFrequently: true });
    if (!inspectCtx) return file;

    inspectCtx.drawImage(decoded.source, 0, 0, decoded.width, decoded.height);
    const imageData = inspectCtx.getImageData(0, 0, decoded.width, decoded.height);
    if (!hasOpaqueAlphaChannel(imageData.data)) {
      return file;
    }

    const target = computeMaxEdgeDimensions(decoded.width, decoded.height, maxEdgePx);
    let targetCanvas = inspectCanvas;
    if (target.scaled) {
      outputCanvas = document.createElement('canvas');
      outputCanvas.width = target.width;
      outputCanvas.height = target.height;
      const outCtx = outputCanvas.getContext('2d');
      if (!outCtx) return file;
      outCtx.imageSmoothingEnabled = true;
      outCtx.imageSmoothingQuality = 'high';
      outCtx.drawImage(decoded.source, 0, 0, target.width, target.height);
      targetCanvas = outputCanvas;
    }

    let encoded = await encodeCanvasToBlob(targetCanvas, 'image/webp', quality);
    if (!encoded || encoded.type !== 'image/webp') {
      encoded = await encodeCanvasToBlob(targetCanvas, 'image/jpeg', quality);
    }
    if (
      !encoded
      || (encoded.type !== 'image/webp' && encoded.type !== 'image/jpeg')
      || encoded.size <= 0
      || encoded.size >= file.size
    ) {
      return file;
    }

    const extension = encoded.type === 'image/webp' ? '.webp' : '.jpg';
    const nextName = replaceImageExtension(file.name, extension);
    return new File([encoded], nextName, {
      type: encoded.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    decoded?.dispose();
    releaseCanvas(outputCanvas);
    releaseCanvas(inspectCanvas);
  }
}

export async function slimClipboardPasteFiles(
  files: File[],
  options: ClipboardImageSlimOptions = {},
): Promise<File[]> {
  const minBytes = options.minBytes ?? CLIPBOARD_IMAGE_SLIM_MIN_BYTES;
  if (!files.some((file) => isCandidateForClipboardSlimming(file, minBytes))) {
    return files;
  }
  const results: File[] = [];
  for (const file of files) {
    results.push(await slimClipboardPasteFile(file, options));
  }
  return results;
}
