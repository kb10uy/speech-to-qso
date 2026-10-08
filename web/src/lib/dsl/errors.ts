/** Raised for utterances that do not conform to the QSO DSL. */
export class DslError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DslError';
    }
}
