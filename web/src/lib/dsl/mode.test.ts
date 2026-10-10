import { describe, expect, it } from 'vitest';
import { modeLabel, modeOf } from './mode';

describe('modeOf', () => {
    it('splits known names into a mode and a submode', () => {
        expect(modeOf('FM')).toEqual({ mode: 'FM' });
        expect(modeOf('lsb')).toEqual({ mode: 'SSB', submode: 'LSB' });
        expect(modeOf(' psk31 ')).toEqual({ mode: 'PSK', submode: 'PSK31' });
        expect(modeOf('C4FM')).toEqual({ mode: 'DIGITALVOICE', submode: 'C4FM' });
    });

    it('takes other names as a mode', () => {
        expect(modeOf('olivia')).toEqual({ mode: 'OLIVIA' });
        expect(modeOf('constructor')).toEqual({ mode: 'CONSTRUCTOR' });
    });
});

describe('modeLabel', () => {
    it('labels a submode and qualifies it with its mode', () => {
        expect(modeLabel({ mode: 'FM' })).toEqual({ label: 'FM' });
        expect(modeLabel({ mode: 'MFSK', submode: 'FT4' })).toEqual({
            label: 'FT4',
            detail: 'MFSK'
        });
    });
});
