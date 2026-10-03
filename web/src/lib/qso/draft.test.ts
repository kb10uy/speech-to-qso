import { describe, expect, it } from 'vitest';
import { parseSpeech, type SpokenUpdate } from '../dsl';
import { applyUpdate, applyUpdates, isPristine, newDraft } from './draft';

const ctx = { anchorHz: 433_000_000 };
const now = new Date('2026-10-03T04:00:00Z');

function spoken(text: string): SpokenUpdate[] {
	const result = parseSpeech(text);
	if (!result.ok) throw new Error(result.error);
	return result.updates;
}

describe('DraftQso', () => {
	it('starts with default reports', () => {
		const draft = newDraft();
		expect(draft).toEqual({
			rstSent: '59',
			rstReceived: '59',
			qsl: 'none',
			frequencyHz: undefined,
			mode: undefined
		});
		expect(isPristine(draft)).toBe(true);
	});

	it('carries frequency and mode over', () => {
		const draft = newDraft({ frequencyHz: 432_940_000, mode: 'FM' });
		expect(draft.frequencyHz).toBe(432_940_000);
		expect(draft.mode).toBe('FM');
	});

	it('updates only the spoken field and records the start time once', () => {
		let draft = newDraft();
		draft = applyUpdate(draft, { kind: 'rstReceived', value: '57' }, ctx, now);
		expect(draft.rstReceived).toBe('57');
		expect(draft.rstSent).toBe('59');
		expect(draft.startedAt).toBe(now.toISOString());

		const later = applyUpdate(
			draft,
			{ kind: 'jcx', value: '100101' },
			ctx,
			new Date(now.getTime() + 60_000)
		);
		expect(later.startedAt).toBe(now.toISOString());
		expect(later.jcx).toBe('100101');
	});

	it('overwrites a field when it is spoken again', () => {
		let { draft } = applyUpdates(newDraft(), spoken('received five seven'), ctx, now);
		({ draft } = applyUpdates(draft, spoken('received five nine'), ctx, now));
		expect(draft.rstReceived).toBe('59');

		({ draft } = applyUpdates(draft, spoken('juliett lima one hotel india sierra'), ctx, now));
		({ draft } = applyUpdates(draft, spoken('juliett lima one hotel india tango'), ctx, now));
		expect(draft.callsign).toBe('JL1HIT');
	});

	it('resolves frequencies against the anchor', () => {
		const { draft, descriptions } = applyUpdates(
			newDraft({ frequencyHz: 430_200_000 }),
			spoken('frequency point nine four'),
			ctx,
			now
		);
		expect(draft.frequencyHz).toBe(432_940_000);
		expect(descriptions).toEqual(['Frequency *.94 → 432.940 MHz']);
	});

	it('does not mutate the input draft', () => {
		const draft = newDraft();
		applyUpdate(draft, { kind: 'callsign', value: 'JL1HIS' }, ctx, now);
		expect(draft.callsign).toBeUndefined();
	});

	it('describes every update of a chained utterance', () => {
		const { draft, descriptions } = applyUpdates(
			newDraft(),
			spoken('juliett lima one hotel india sierra sent five five card requested mode foxtrot mike'),
			ctx,
			now
		);
		expect(draft).toMatchObject({
			callsign: 'JL1HIS',
			rstSent: '55',
			qsl: 'requested',
			mode: 'FM'
		});
		expect(descriptions).toEqual([
			'Callsign → JL1HIS',
			'RST sent → 55',
			'QSL requested',
			'Mode → FM'
		]);
	});
});
