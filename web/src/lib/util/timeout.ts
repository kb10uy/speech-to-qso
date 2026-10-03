export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Rejects with `message` if `promise` has not settled after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(v) => (clearTimeout(timer), resolve(v)),
			(e) => (clearTimeout(timer), reject(e))
		);
	});
}
