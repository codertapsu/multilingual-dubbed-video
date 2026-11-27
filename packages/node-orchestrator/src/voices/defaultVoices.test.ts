import { describe, expect, it } from 'vitest';

import { defaultVoicesFor } from './defaultVoices.js';

/** The user's two clones (2026-11-27), and a built-in voice. */
const QUAN = { id: 'vp_d54fadbeedb4b84f', gender: 'male' as const };
const HA_MY = { id: 'vp_1545a09ba583ad6a', gender: 'female' as const };
const BUILTIN = { id: 'vieneu38-minh-duc', gender: 'male' as const };
const wanted = { male: QUAN.id, female: HA_MY.id };

describe("the user's default voices for a new project", () => {
  it('fills the genders the project names no voice for, with voices it can speak', () => {
    expect(defaultVoicesFor(wanted, {}, [QUAN, HA_MY, BUILTIN])).toEqual({ defaultMaleVoiceId: QUAN.id, defaultFemaleVoiceId: HA_MY.id });
    // A preset or job that names its own keeps it.
    expect(defaultVoicesFor(wanted, { defaultMaleVoiceId: BUILTIN.id }, [QUAN, HA_MY, BUILTIN])).toEqual({ defaultFemaleVoiceId: HA_MY.id });
  });

  it('never gives a voice the project cannot speak with, one of the other gender, or one kept for a main character', () => {
    // Another engine (its voices only are usable): none.
    expect(defaultVoicesFor(wanted, {}, [BUILTIN])).toEqual({});
    // A male voice asked for the women: not given.
    expect(defaultVoicesFor({ female: QUAN.id }, {}, [QUAN])).toEqual({});
    // Kept for one main character: never a default.
    expect(defaultVoicesFor(wanted, {}, [{ ...QUAN, mainOnly: true }, HA_MY])).toEqual({ defaultFemaleVoiceId: HA_MY.id });
    expect(defaultVoicesFor(undefined, {}, [QUAN, HA_MY])).toEqual({});
  });
});
