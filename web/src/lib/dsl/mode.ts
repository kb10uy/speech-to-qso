/** An ADIF mode, with the submode where ADIF has one for what was spoken. */
export interface QsoMode {
    mode: string;
    submode?: string;
}

/**
 * Modes accepted by `mode ...`, by the name an operator says. Several of these names are ADIF
 * submodes (FT4 is MFSK, USB is SSB), and some are import-only ADIF modes that must be exported
 * as submodes (C4FM, DSTAR, PSK31).
 */
export const KNOWN_MODES = {
    FM: { mode: 'FM' },
    AM: { mode: 'AM' },
    SSB: { mode: 'SSB' },
    USB: { mode: 'SSB', submode: 'USB' },
    LSB: { mode: 'SSB', submode: 'LSB' },
    CW: { mode: 'CW' },
    RTTY: { mode: 'RTTY' },
    FT8: { mode: 'FT8' },
    FT4: { mode: 'MFSK', submode: 'FT4' },
    PSK31: { mode: 'PSK', submode: 'PSK31' },
    JT65: { mode: 'JT65' },
    SSTV: { mode: 'SSTV' },
    DSTAR: { mode: 'DIGITALVOICE', submode: 'DSTAR' },
    C4FM: { mode: 'DIGITALVOICE', submode: 'C4FM' },
    DMR: { mode: 'DIGITALVOICE', submode: 'DMR' }
} as const satisfies Record<string, QsoMode>;

export type KnownModeName = keyof typeof KNOWN_MODES;

export function isKnownModeName(name: string): name is KnownModeName {
    return Object.hasOwn(KNOWN_MODES, name);
}

/** The mode for a name; a name that is not known is taken as an ADIF mode as is. */
export function modeOf(name: string): QsoMode {
    const upper = name.trim().toUpperCase();
    return isKnownModeName(upper) ? { ...KNOWN_MODES[upper] } : { mode: upper };
}

/** The submode is what the operator chose, so it is the label; the mode only qualifies it. */
export function modeLabel({ mode, submode }: QsoMode): { label: string; detail?: string } {
    return submode === undefined ? { label: mode } : { label: submode, detail: mode };
}
