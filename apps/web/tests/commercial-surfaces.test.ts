// The shipping defaults live in `src/commercial-surfaces.ts`, and every mount
// point trusts them — but the shared test setup turns every surface ON so the
// suites that own those surfaces can still assert their behavior. That makes
// the real default invisible to those suites, so this file reads the module
// from a fresh registry and pins it.
//
// If a surface is deliberately restored to the product, flip it here too: the
// point is that shipping a promo surface is a decision somebody wrote down,
// not a default that drifted back.
import { describe, expect, it, vi } from 'vitest';

const SURFACE_MODULE = '../src/commercial-surfaces';

async function freshDefaults() {
  vi.resetModules();
  return import(SURFACE_MODULE);
}

describe('commercial surface defaults', () => {
  it('ships every commercial surface switched off', async () => {
    const { COMMERCIAL_SURFACES } = await freshDefaults();

    expect(COMMERCIAL_SURFACES).toEqual({
      experienceSurvey: false,
      invitePrompts: false,
      githubStars: false,
      referralProgram: false,
      cmsCampaigns: false,
      modelCampaigns: false,
      upgradePrompts: false,
      whatsNew: false,
      subscriptionAnnouncements: false,
      sharePrompts: false,
    });
  });

  it('reports the table through commercialSurfaceEnabled', async () => {
    const { COMMERCIAL_SURFACES, commercialSurfaceEnabled } = await freshDefaults();

    for (const surface of Object.keys(COMMERCIAL_SURFACES) as Array<
      keyof typeof COMMERCIAL_SURFACES
    >) {
      expect(commercialSurfaceEnabled(surface)).toBe(false);
    }
  });

  it('follows a surface that is switched back on', async () => {
    const { COMMERCIAL_SURFACES, commercialSurfaceEnabled } = await freshDefaults();

    COMMERCIAL_SURFACES.experienceSurvey = true;

    expect(commercialSurfaceEnabled('experienceSurvey')).toBe(true);
    // Only the surface that was restored moves.
    expect(commercialSurfaceEnabled('invitePrompts')).toBe(false);
  });
});
