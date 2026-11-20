import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { spawnSync } from 'node:child_process';

export const DEFAULT_OD_NEXT_SNAPSHOT_IMAGE_DOWNSAMPLE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_OD_NEXT_SNAPSHOT_IMAGE_MAX_EDGE_PX = 2560;

const DOWNSAMPLEABLE_IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const FFMPEG_PIPE_MAX_BUFFER = 256 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 30_000;

function resolveFfmpegPath(): string {
  return process.env.HYPERFRAMES_FFMPEG_PATH?.trim() || ffmpegInstaller.path;
}

export function isDownsampleableSnapshotImageType(mediaType: string): boolean {
  return DOWNSAMPLEABLE_IMAGE_MEDIA_TYPES.has(mediaType);
}

/**
 * Inspect PNG header chunks prior to the first `IDAT` without decompressing pixel data:
 * - Detects APNG (`acTL` chunk) so animated PNGs are never flattened.
 * - Determines whether alpha is structurally possible (`colorType` 4 or 6, or `tRNS` chunk).
 */
export function inspectPngAlphaAndAnimation(bytes: Buffer): {
  animated: boolean;
  potentiallyHasAlpha: boolean;
} {
  if (bytes.length < 29) {
    return { animated: false, potentiallyHasAlpha: true };
  }
  let colorType = bytes[25] ?? 6;
  let hasTrns = false;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const chunkLen = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString('ascii', offset + 4, offset + 8);
    if (chunkType === 'IHDR' && offset + 8 + 10 <= bytes.length) {
      colorType = bytes[offset + 8 + 9] ?? colorType;
    } else if (chunkType === 'acTL') {
      return { animated: true, potentiallyHasAlpha: true };
    } else if (chunkType === 'tRNS') {
      hasTrns = true;
    } else if (chunkType === 'IDAT' || chunkType === 'IEND') {
      break;
    }
    const next = offset + 12 + chunkLen;
    if (next <= offset) break;
    offset = next;
  }
  const potentiallyHasAlpha = colorType === 4 || colorType === 6 || hasTrns;
  return { animated: false, potentiallyHasAlpha };
}

/**
 * Inspect RIFF/WEBP chunks for animation (`VP8X` animation bit) and potential alpha.
 */
export function inspectWebpAlphaAndAnimation(bytes: Buffer): {
  animated: boolean;
  potentiallyHasAlpha: boolean;
} {
  if (bytes.length < 20) {
    return { animated: false, potentiallyHasAlpha: true };
  }
  const fourCc = bytes.toString('ascii', 12, 16);
  if (fourCc === 'VP8X' && bytes.length >= 21) {
    const flags = bytes[20] ?? 0;
    return {
      animated: (flags & 0x02) !== 0,
      potentiallyHasAlpha: (flags & 0x10) !== 0,
    };
  }
  if (fourCc === 'VP8 ') {
    return { animated: false, potentiallyHasAlpha: false };
  }
  if (fourCc === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    // Bit 28 of the 32-bit VP8L bitstream header (`byte[24] & 0x10`) is `alpha_is_used`.
    return {
      animated: false,
      potentiallyHasAlpha: ((bytes[24] ?? 0) & 0x10) !== 0,
    };
  }
  return { animated: false, potentiallyHasAlpha: true };
}

function hasTransparentPixelViaFfmpeg(ffmpegPath: string, bytes: Buffer): boolean {
  const probe = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-vf',
      'format=rgba,alphaextract',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1',
    ],
    {
      input: bytes,
      maxBuffer: FFMPEG_PIPE_MAX_BUFFER,
      timeout: FFMPEG_TIMEOUT_MS,
    },
  );
  if (probe.error || probe.status !== 0 || probe.stdout.length === 0) {
    // Fail safe: preserve alpha channel as PNG whenever probing is inconclusive.
    return true;
  }
  const allOpaquePlane = Buffer.alloc(probe.stdout.length, 0xff);
  return !allOpaquePlane.equals(probe.stdout);
}

/**
 * Generates an in-memory visual snapshot copy (long edge ≤ `maxEdgePx`) for AI
 * inspection without mutating the project workspace source file on disk:
 * - Opaque raster images encode to crisp 4:4:4 JPEG (`-q:v 3`).
 * - Images with any transparent/semi-transparent pixel encode to RGBA PNG,
 *   preserving the alpha channel intact.
 * - Animated images or any unexpected codec error fall back to `bytes` untouched.
 */
export function downsampleSnapshotImageBytes(
  bytes: Buffer,
  mediaType: string,
  maxEdgePx = DEFAULT_OD_NEXT_SNAPSHOT_IMAGE_MAX_EDGE_PX,
): Buffer {
  if (!isDownsampleableSnapshotImageType(mediaType) || bytes.length === 0) {
    return bytes;
  }

  let potentiallyHasAlpha = false;
  if (mediaType === 'image/png') {
    const pngInfo = inspectPngAlphaAndAnimation(bytes);
    if (pngInfo.animated) return bytes;
    potentiallyHasAlpha = pngInfo.potentiallyHasAlpha;
  } else if (mediaType === 'image/webp') {
    const webpInfo = inspectWebpAlphaAndAnimation(bytes);
    if (webpInfo.animated) return bytes;
    potentiallyHasAlpha = webpInfo.potentiallyHasAlpha;
  }

  const ffmpegPath = resolveFfmpegPath();
  const hasTransparency = potentiallyHasAlpha
    ? hasTransparentPixelViaFfmpeg(ffmpegPath, bytes)
    : false;

  const clampedEdge = Math.max(64, Math.floor(maxEdgePx));
  const scaleExpr = `scale='min(${clampedEdge},iw)':'min(${clampedEdge},ih)':force_original_aspect_ratio=decrease:flags=lanczos`;

  const encodeArgs = hasTransparency
    ? [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-frames:v',
        '1',
        '-vf',
        `${scaleExpr},format=rgba`,
        '-flags:v',
        '+bitexact',
        '-c:v',
        'png',
        '-compression_level',
        '6',
        '-pred',
        'mixed',
        '-f',
        'image2pipe',
        'pipe:1',
      ]
    : [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-frames:v',
        '1',
        '-vf',
        `${scaleExpr},format=yuvj444p`,
        '-flags:v',
        '+bitexact',
        '-c:v',
        'mjpeg',
        '-q:v',
        '3',
        '-f',
        'image2pipe',
        'pipe:1',
      ];

  const encoded = spawnSync(ffmpegPath, encodeArgs, {
    input: bytes,
    maxBuffer: FFMPEG_PIPE_MAX_BUFFER,
    timeout: FFMPEG_TIMEOUT_MS,
  });

  if (
    encoded.error
    || encoded.status !== 0
    || encoded.stdout.length === 0
    || encoded.stdout.length >= bytes.length
  ) {
    return bytes;
  }

  return encoded.stdout;
}
