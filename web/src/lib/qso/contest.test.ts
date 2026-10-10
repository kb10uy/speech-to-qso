import { describe, expect, it } from 'vitest';
import {
    contestProblems,
    defaultContest,
    exchangeString,
    exchangeTemplateProblem,
    expandExchange,
    usesSerial
} from './contest';

describe('expandExchange', () => {
    it('pads the serial number to three digits by default', () => {
        expect(expandExchange('{serial}', 1)).toBe('001');
        expect(expandExchange('{serial}', 1234)).toBe('1234');
        expect(expandExchange('{serial:4}', 12)).toBe('0012');
        expect(expandExchange('{serial:1}', 12)).toBe('12');
    });

    it('sends everything else as it is, in capitals', () => {
        expect(expandExchange(' 1001m ', 5)).toBe('1001M');
        expect(expandExchange('{serial}h', 5)).toBe('005H');
        expect(expandExchange('{serial} {serial:2}', 5)).toBe('005 05');
    });
});

describe('usesSerial', () => {
    it('finds the placeholder', () => {
        expect(usesSerial('{serial}M')).toBe(true);
        expect(usesSerial('{serial:4}')).toBe(true);
        expect(usesSerial('1001M')).toBe(false);
        expect(usesSerial('')).toBe(false);
    });
});

describe('exchangeTemplateProblem', () => {
    it('accepts serial placeholders and plain text', () => {
        for (const template of ['', '1001M', '{serial}', '{serial:4}M', '25 {serial}'])
            expect(exchangeTemplateProblem(template), template).toBeUndefined();
    });

    it('rejects anything else in braces', () => {
        for (const template of ['{nr}', '{serial:0}', '{serial:10}', '{serial', 'serial}', '{}'])
            expect(exchangeTemplateProblem(template), template).toMatch(/only \{serial\}/);
    });
});

describe('exchangeString', () => {
    const contest = defaultContest();

    it('joins the RST and the number when asked to', () => {
        expect(exchangeString(contest, '59', '001')).toBe('001');
        expect(exchangeString({ ...contest, includeRst: true }, '59', '001')).toBe('59 001');
        expect(exchangeString({ ...contest, includeRst: true }, '599', undefined)).toBe('599');
        expect(exchangeString(contest, '59', undefined)).toBeUndefined();
    });
});

describe('contestProblems', () => {
    it('only checks a contest that is on', () => {
        const broken = { ...defaultContest(), exchangeTemplate: '{nr}', nextSerial: 0 };
        expect(contestProblems(broken)).toEqual([]);
        expect(contestProblems({ ...broken, enabled: true })).toEqual([
            'Sent number: only {serial} and {serial:N} can be used',
            'Next serial number must be 1 or more'
        ]);
    });
});
