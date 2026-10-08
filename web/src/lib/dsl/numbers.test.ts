import { describe, expect, it } from 'vitest';
import { DslError } from './errors';
import { readDigits } from './numbers';

const digits = (text: string) => {
    const tokens = text.split(' ');
    const result = readDigits(tokens, 0);
    expect(result.end).toBe(tokens.length);
    return result.digits;
};

describe('readDigits', () => {
    it('reads single digits', () => {
        expect(digits('one zero zero one zero one')).toBe('100101');
        expect(digits('niner tree fife')).toBe('935');
        expect(digits('1 4 5')).toBe('145');
    });

    it('preserves leading zeros', () => {
        expect(digits('zero one zero zero eight')).toBe('01008');
        expect(digits('oh two')).toBe('02');
    });

    it('concatenates groups like radio operators read numbers', () => {
        expect(digits('four thirty two')).toBe('432');
        expect(digits('one forty five')).toBe('145');
        expect(digits('thirty two')).toBe('32');
        expect(digits('fourteen five')).toBe('145');
        expect(digits('fifty nine')).toBe('59');
        expect(digits('twenty')).toBe('20');
        expect(digits('twenty zero')).toBe('200');
    });

    it('understands hundred', () => {
        expect(digits('four hundred')).toBe('400');
        expect(digits('four hundred two')).toBe('402');
        expect(digits('four hundred thirty two')).toBe('432');
        expect(digits('one hundred forty five')).toBe('145');
        expect(digits('one hundred twelve')).toBe('112');
    });

    it('understands double and triple', () => {
        expect(digits('double five')).toBe('55');
        expect(digits('triple nine')).toBe('999');
    });

    it('stops at the first non-number token', () => {
        expect(readDigits(['five', 'seven', 'point', 'two'], 0)).toEqual({ digits: '57', end: 2 });
        expect(readDigits(['point', 'two'], 0)).toEqual({ digits: '', end: 0 });
        expect(readDigits(['constructor'], 0)).toEqual({ digits: '', end: 0 });
    });

    it('rejects misplaced hundred', () => {
        expect(() => readDigits(['hundred'], 0)).toThrow(DslError);
        expect(() => readDigits(['thirty', 'two', 'hundred'], 0)).toThrow(DslError);
        expect(() => readDigits(['double', 'point'], 0)).toThrow(DslError);
    });
});
