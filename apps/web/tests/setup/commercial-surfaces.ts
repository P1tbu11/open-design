// Commercial surfaces ship switched off (`src/commercial-surfaces.ts`), but the
// suites that own those surfaces still have to test them. Rather than teach
// hundreds of assertions about a flag they are not about, enable every surface
// for the test environment and let `tests/commercial-surfaces.test.ts` pin the
// shipping defaults from a freshly imported module.
import { beforeEach } from 'vitest';

import {
  COMMERCIAL_SURFACES,
  type CommercialSurface,
} from '../../src/commercial-surfaces';

const ALL_SURFACES = Object.keys(COMMERCIAL_SURFACES) as CommercialSurface[];

// A test that switches one surface off (`delete COMMERCIAL_SURFACES.x` or an
// explicit `false`) must not leak that into the next test in the same file.
beforeEach(() => {
  for (const surface of ALL_SURFACES) COMMERCIAL_SURFACES[surface] = true;
});
