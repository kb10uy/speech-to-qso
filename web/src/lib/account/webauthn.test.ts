import { describe, expect, it } from 'vitest';
import {
	authenticationJson,
	base64urlToBytes,
	bytesToBase64url,
	creationOptions,
	registrationJson,
	requestOptions
} from './webauthn';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('base64url', () => {
	it('round-trips without padding', () => {
		for (const input of [bytes(), bytes(0xfb), bytes(0xfb, 0xff), bytes(0xfb, 0xff, 0xbf, 0x00)]) {
			const encoded = bytesToBase64url(input);
			expect(encoded).not.toMatch(/[+/=]/);
			expect(base64urlToBytes(encoded)).toEqual(input);
		}
		expect(bytesToBase64url(bytes(0xfb, 0xff))).toBe('-_8');
	});

	it('encodes views and buffers', () => {
		const buffer = bytes(1, 2, 3, 4).buffer;
		expect(bytesToBase64url(buffer)).toBe('AQIDBA');
		expect(bytesToBase64url(new Uint8Array(buffer, 1, 2))).toBe('AgM');
	});
});

describe('creationOptions', () => {
	it('decodes binary fields and drops nulls', () => {
		const options = creationOptions({
			publicKey: {
				rp: { id: 'qso.example.com', name: 'Speech to QSO' },
				user: { id: 'AQID', name: 'JJ1ABC', displayName: 'JJ1ABC' },
				challenge: 'BAUG',
				pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
				excludeCredentials: [{ type: 'public-key', id: 'BwgJ' }],
				authenticatorSelection: { residentKey: 'required', authenticatorAttachment: null },
				hints: null
			}
		}).publicKey!;
		expect(options.challenge).toEqual(bytes(4, 5, 6));
		expect(options.user.id).toEqual(bytes(1, 2, 3));
		expect(options.user.name).toBe('JJ1ABC');
		expect(options.excludeCredentials![0].id).toEqual(bytes(7, 8, 9));
		expect(options.authenticatorSelection).toEqual({ residentKey: 'required' });
		expect('hints' in options).toBe(false);
	});
});

describe('requestOptions', () => {
	it('decodes the challenge', () => {
		const options = requestOptions({
			publicKey: { challenge: 'BAUG', rpId: 'qso.example.com', userVerification: 'required' }
		}).publicKey!;
		expect(options.challenge).toEqual(bytes(4, 5, 6));
		expect(options.rpId).toBe('qso.example.com');
		expect(options.allowCredentials).toBeUndefined();
	});
});

describe('credential JSON', () => {
	const credential = (response: object) =>
		({
			id: 'AQID',
			rawId: bytes(1, 2, 3).buffer,
			type: 'public-key',
			response,
			getClientExtensionResults: () => ({ credProps: { rk: true } })
		}) as unknown as PublicKeyCredential;

	it('encodes a registration', () => {
		const json = registrationJson(
			credential({
				clientDataJSON: bytes(1).buffer,
				attestationObject: bytes(2).buffer,
				getTransports: () => ['internal', 'hybrid']
			})
		);
		expect(json).toEqual({
			id: 'AQID',
			rawId: 'AQID',
			type: 'public-key',
			clientExtensionResults: { credProps: { rk: true } },
			response: {
				clientDataJSON: 'AQ',
				attestationObject: 'Ag',
				transports: ['internal', 'hybrid']
			}
		});
	});

	it('encodes an assertion', () => {
		const json = authenticationJson(
			credential({
				clientDataJSON: bytes(1).buffer,
				authenticatorData: bytes(2).buffer,
				signature: bytes(3).buffer,
				userHandle: bytes(4).buffer
			})
		);
		expect(json.response).toEqual({
			clientDataJSON: 'AQ',
			authenticatorData: 'Ag',
			signature: 'Aw',
			userHandle: 'BA'
		});
	});
});
