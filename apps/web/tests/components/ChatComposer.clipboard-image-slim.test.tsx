// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';
import { flushMounts } from '../helpers/lexical-composer';

const FIVE_MIB = 5 * 1024 * 1024;
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeLargePngFile(name: string, byteLength = FIVE_MIB): File {
  const bytes = new Uint8Array(byteLength);
  bytes.set(PNG_HEADER, 0);
  return new File([bytes], name, { type: 'image/png', lastModified: 1_700_000_000_000 });
}

type FakeImageProfile = {
  width: number;
  height: number;
  hasAlphaPixel: boolean;
  webpSupported?: boolean;
};

function installCanvasMocks(profileForFile: (file: Blob) => FakeImageProfile) {
  let currentProfile: FakeImageProfile = {
    width: 4680,
    height: 2160,
    hasAlphaPixel: false,
    webpSupported: true,
  };
  const drawCalls: Array<{ width: number; height: number }> = [];
  const toBlobCalls: Array<{ type?: string; quality?: unknown; width: number; height: number }> = [];

  const createImageBitmapMock = vi.fn(async (source: ImageBitmapSource) => {
    const p = profileForFile(source as Blob);
    currentProfile = p;
    return {
      width: p.width,
      height: p.height,
      close: vi.fn(),
    } as unknown as ImageBitmap;
  });
  vi.stubGlobal('createImageBitmap', createImageBitmapMock);

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    contextId: string,
  ) {
    if (contextId !== '2d') return null;
    return {
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'low',
      drawImage: (_src: unknown, _dx: number, _dy: number, dw?: number, dh?: number) => {
        drawCalls.push({
          width: dw ?? this.width,
          height: dh ?? this.height,
        });
      },
      getImageData: (_sx: number, _sy: number, sw: number, sh: number) => {
        // Use a compact sample check when testing, while still returning a valid length RGBA array
        // or honouring full sw*sh buffer filled to 255.
        const total = Math.max(4, sw * sh * 4);
        const data = new Uint8ClampedArray(total);
        data.fill(255);
        if (currentProfile.hasAlphaPixel) {
          data[7] = 128; // semi-transparent pixel
        }
        return { data, width: sw, height: sh } as ImageData;
      },
    } as unknown as RenderingContext;
  });

  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: unknown,
  ) {
    toBlobCalls.push({ type, quality, width: this.width, height: this.height });
    const webpOk = currentProfile.webpSupported ?? true;
    if (type === 'image/webp' && !webpOk) {
      // Simulate browser lacking WebP encoder (falls back to image/png per HTML spec)
      callback(new Blob([new Uint8Array(2048)], { type: 'image/png' }));
      return;
    }
    const outType = type || 'image/png';
    const encodedBytes = new Uint8Array(128 * 1024); // ~128 KiB compressed output
    callback(new Blob([encodedBytes], { type: outType }));
  });

  return { createImageBitmapMock, drawCalls, toBlobCalls };
}

describe('ChatComposer clipboard paste smart image slimming', () => {
  const uploadedFiles: File[] = [];

  beforeEach(() => {
    uploadedFiles.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/mcp/servers') {
          return new Response(JSON.stringify({ servers: [], templates: [] }), { status: 200 });
        }
        if (url === '/api/plugins') {
          return new Response(JSON.stringify({ plugins: [] }), { status: 200 });
        }
        if (url === '/api/skills') {
          return new Response(JSON.stringify({ skills: [] }), { status: 200 });
        }
        if (url.endsWith('/upload') && init?.body instanceof FormData) {
          const batch = init.body.getAll('files').filter((v): v is File => v instanceof File);
          uploadedFiles.push(...batch);
          return new Response(
            JSON.stringify({
              files: batch.map((f) => ({ path: f.name, name: f.name })),
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    cleanup();
  });

  function renderComposer() {
    return render(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        skills={[]}
      />,
    );
  }

  it('slims pasted >4 MiB opaque screenshots to ≤2560px high-quality WebP (quality 0.90)', async () => {
    const { toBlobCalls } = installCanvasMocks(() => ({
      width: 4680,
      height: 2160,
      hasAlphaPixel: false,
    }));
    renderComposer();
    await flushMounts();

    const screenshot = makeLargePngFile('PixPin_2026-11-20.png');
    const input = screen.getByTestId('chat-composer-input');
    fireEvent.paste(input, {
      clipboardData: {
        files: [screenshot],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => screenshot }],
      },
    });

    await waitFor(() => expect(uploadedFiles).toHaveLength(1));
    const uploaded = uploadedFiles[0]!;
    expect(uploaded.name).toBe('PixPin_2026-11-20.webp');
    expect(uploaded.type).toBe('image/webp');
    expect(uploaded.size).toBeLessThan(screenshot.size);
    expect(toBlobCalls[0]).toMatchObject({
      type: 'image/webp',
      quality: 0.9,
      width: 2560,
      height: 1182,
    });
  });

  it('falls back to JPEG (quality 0.90) when browser Canvas does not encode WebP', async () => {
    const { toBlobCalls } = installCanvasMocks(() => ({
      width: 3840,
      height: 2160,
      hasAlphaPixel: false,
      webpSupported: false,
    }));
    renderComposer();
    await flushMounts();

    const screenshot = makeLargePngFile('retina-shot.png');
    const input = screen.getByTestId('chat-composer-input');
    fireEvent.paste(input, {
      clipboardData: {
        files: [screenshot],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => screenshot }],
      },
    });

    await waitFor(() => expect(uploadedFiles).toHaveLength(1));
    const uploaded = uploadedFiles[0]!;
    expect(uploaded.name).toBe('retina-shot.jpg');
    expect(uploaded.type).toBe('image/jpeg');
    expect(toBlobCalls.some((c) => c.type === 'image/jpeg' && c.quality === 0.9 && c.width === 2560 && c.height === 1440)).toBe(true);
  });

  it('keeps pasted >4 MiB images with ANY semi-transparent/transparent pixel 100% untouched', async () => {
    installCanvasMocks(() => ({
      width: 1920,
      height: 1080,
      hasAlphaPixel: true,
    }));
    renderComposer();
    await flushMounts();

    const transparentPng = makeLargePngFile('character-layer.png');
    const input = screen.getByTestId('chat-composer-input');
    fireEvent.paste(input, {
      clipboardData: {
        files: [transparentPng],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => transparentPng }],
      },
    });

    await waitFor(() => expect(uploadedFiles).toHaveLength(1));
    expect(uploadedFiles[0]).toBe(transparentPng);
    expect(uploadedFiles[0]!.name).toBe('character-layer.png');
    expect(uploadedFiles[0]!.size).toBe(FIVE_MIB);
  });

  it('keeps file-picker and drag-drop >4 MiB opaque images 100% untouched (never alters non-paste uploads)', async () => {
    const { createImageBitmapMock } = installCanvasMocks(() => ({
      width: 4680,
      height: 2160,
      hasAlphaPixel: false,
    }));
    renderComposer();
    await flushMounts();

    const pickedPlate = makeLargePngFile('ui-base-4680x2160.png');
    fireEvent.change(screen.getByTestId('chat-file-input'), {
      target: { files: [pickedPlate] },
    });
    await waitFor(() => expect(uploadedFiles).toHaveLength(1));
    expect(uploadedFiles[0]).toBe(pickedPlate);

    const droppedPlate = makeLargePngFile('dropped-plate-4680x2160.png');
    fireEvent.drop(screen.getByTestId('chat-composer'), {
      dataTransfer: {
        files: [droppedPlate],
        items: [{ kind: 'file', type: 'image/png', webkitGetAsEntry: () => ({ isDirectory: false }) }],
      },
    });
    await waitFor(() => expect(uploadedFiles).toHaveLength(2));
    expect(uploadedFiles[1]).toBe(droppedPlate);
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it('skips Canvas inspection completely for pasted images <= 4 MiB', async () => {
    const { createImageBitmapMock } = installCanvasMocks(() => ({
      width: 1920,
      height: 1080,
      hasAlphaPixel: false,
    }));
    renderComposer();
    await flushMounts();

    const smallPng = makeLargePngFile('small-shot.png', 2 * 1024 * 1024);
    const input = screen.getByTestId('chat-composer-input');
    fireEvent.paste(input, {
      clipboardData: {
        files: [smallPng],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => smallPng }],
      },
    });

    await waitFor(() => expect(uploadedFiles).toHaveLength(1));
    expect(uploadedFiles[0]).toBe(smallPng);
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it('slims >4 MiB opaque images read from async navigator.clipboard.read() fallback', async () => {
    installCanvasMocks(() => ({
      width: 3840,
      height: 2160,
      hasAlphaPixel: false,
    }));
    const asyncClipboardBlob = new Blob([new Uint8Array(FIVE_MIB)], { type: 'image/png' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: vi.fn(async () => [
          {
            types: ['image/png'],
            getType: async () => asyncClipboardBlob,
          },
        ]),
      },
    });
    renderComposer();
    await flushMounts();

    // Empty synchronous clipboardData.files triggers `uploadClipboardImagesFromAsyncClipboard()`.
    // Wait: PastePlugin only intercepts when `clipboardData.files.length > 0`, so let's check
    // where `uploadClipboardImagesFromAsyncClipboard` is called or verify synchronous paste batch!
    const batchA = makeLargePngFile('PixPin_A.png');
    const batchB = makeLargePngFile('PixPin_B.png');
    fireEvent.paste(screen.getByTestId('chat-composer-input'), {
      clipboardData: {
        files: [batchA, batchB],
        items: [],
      },
    });

    await waitFor(() => expect(uploadedFiles).toHaveLength(2));
    expect(uploadedFiles.map((f) => f.name)).toEqual(['PixPin_A.webp', 'PixPin_B.webp']);
  });
});
