import { COMMAND_KEYWORDS, type CommandKind } from './lexicon';

export interface KeywordMatch {
    kind: CommandKind;
    length: number;
}

const KEYWORD_SEQUENCES: { kind: CommandKind; seq: readonly string[] }[] = (
    Object.entries(COMMAND_KEYWORDS) as [CommandKind, readonly (readonly string[])[]][]
)
    .flatMap(([kind, seqs]) => seqs.map((seq) => ({ kind, seq })))
    // Longest match first so that e.g. "call sign" wins over "call".
    .sort((a, b) => b.seq.length - a.seq.length);

export function matchKeyword(tokens: readonly string[], i: number): KeywordMatch | null {
    for (const { kind, seq } of KEYWORD_SEQUENCES) {
        if (seq.every((word, k) => tokens[i + k] === word)) return { kind, length: seq.length };
    }
    return null;
}
