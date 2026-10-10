/** Contest settings of this device (the Contest tab). */
export interface ContestSettings {
    /** In a contest, every QSO needs the other station's number and records both exchanges. */
    enabled: boolean;
    /** ADIF `CONTEST_ID`; may be empty. */
    contestId: string;
    /** What we send, e.g. `{serial}` or `1001M`. See {@link expandExchange}. */
    exchangeTemplate: string;
    /** The serial number the next QSO sends. */
    nextSerial: number;
    /**
     * Whether `STX_STRING` and `SRX_STRING` start with the RST (`59001`). Only the screen puts a
     * space between them.
     */
    includeRst: boolean;
}

/** Longest exchange string, RST included (same limit as the server). */
export const EXCHANGE_STRING_MAX_LENGTH = 32;
export const DEFAULT_SERIAL_WIDTH = 3;

export function defaultContest(): ContestSettings {
    return {
        enabled: false,
        contestId: '',
        exchangeTemplate: '{serial}',
        nextSerial: 1,
        includeRst: false
    };
}

const SERIAL_PLACEHOLDER = /\{serial(?::([1-9]))?\}/g;

/** True if the template sends a serial number, so that every logged QSO uses one up. */
export function usesSerial(template: string): boolean {
    return template.search(SERIAL_PLACEHOLDER) !== -1;
}

/**
 * Expands a sent exchange template: `{serial}` is the serial number padded to three digits
 * (`001`), `{serial:N}` to N digits; everything else is sent as it is, in capitals.
 */
export function expandExchange(template: string, serial: number): string {
    return template
        .trim()
        .replace(SERIAL_PLACEHOLDER, (_, width?: string) =>
            String(serial).padStart(width === undefined ? DEFAULT_SERIAL_WIDTH : Number(width), '0')
        )
        .toUpperCase();
}

/** Why the template cannot be used, or `undefined` if it is fine. */
export function exchangeTemplateProblem(template: string): string | undefined {
    const rest = template.replace(SERIAL_PLACEHOLDER, '');
    if (/[{}]/.test(rest)) return 'Sent number: only {serial} and {serial:N} can be used';
    if (/\p{Cc}/u.test(rest)) return 'Sent number has control characters';
    return undefined;
}

/** The exchange as recorded in `STX_STRING` / `SRX_STRING`; `undefined` if there is none. */
export function exchangeString(
    contest: ContestSettings,
    rst: string,
    exchange: string | undefined
): string | undefined {
    const string = (contest.includeRst ? rst : '') + (exchange ?? '');
    return string === '' ? undefined : string;
}

export function contestProblems(contest: ContestSettings): string[] {
    if (!contest.enabled) return [];
    const problems: string[] = [];
    const template = exchangeTemplateProblem(contest.exchangeTemplate);
    if (template !== undefined) problems.push(template);
    if (!Number.isSafeInteger(contest.nextSerial) || contest.nextSerial < 1)
        problems.push('Next serial number must be 1 or more');
    return problems;
}
