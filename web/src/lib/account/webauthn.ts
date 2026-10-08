/**
 * Converts between the JSON the server sends and receives (base64url strings) and the binary
 * WebAuthn API, so that browsers without `PublicKeyCredential.parseCreationOptionsFromJSON`
 * work too.
 */

export function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
    const base64 = s.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function bytesToBase64url(bytes: ArrayBuffer | ArrayBufferView): string {
    const view =
        bytes instanceof ArrayBuffer
            ? new Uint8Array(bytes)
            : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let binary = '';
    for (const b of view) binary += String.fromCharCode(b);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** WebIDL dictionaries reject `null` where a sequence or dictionary is expected. */
function withoutNulls(value: Json): Json {
    if (Array.isArray(value)) return value.map(withoutNulls);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, v]) => v !== null)
                .map(([k, v]) => [k, withoutNulls(v)])
        );
    }
    return value;
}

interface CredentialDescriptorJson {
    type: string;
    id: string;
    transports?: string[];
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
    if (!Array.isArray(list)) return undefined;
    return (list as CredentialDescriptorJson[]).map((d) => ({
        ...d,
        type: 'public-key',
        id: base64urlToBytes(d.id),
        transports: d.transports as AuthenticatorTransport[] | undefined
    }));
}

/** `{ publicKey: … }` from the server → options for `navigator.credentials.create`. */
export function creationOptions(json: unknown): CredentialCreationOptions {
    const { publicKey } = withoutNulls(json as Json) as unknown as {
        publicKey: Record<string, unknown> & {
            challenge: string;
            user: { id: string; name: string; displayName: string };
        };
    };
    return {
        publicKey: {
            ...(publicKey as unknown as PublicKeyCredentialCreationOptions),
            challenge: base64urlToBytes(publicKey.challenge),
            user: { ...publicKey.user, id: base64urlToBytes(publicKey.user.id) },
            excludeCredentials: descriptors(publicKey.excludeCredentials)
        }
    };
}

/** `{ publicKey: … }` from the server → options for `navigator.credentials.get`. */
export function requestOptions(json: unknown): CredentialRequestOptions {
    const { publicKey } = withoutNulls(json as Json) as unknown as {
        publicKey: Record<string, unknown> & { challenge: string };
    };
    return {
        publicKey: {
            ...(publicKey as unknown as PublicKeyCredentialRequestOptions),
            challenge: base64urlToBytes(publicKey.challenge),
            allowCredentials: descriptors(publicKey.allowCredentials)
        }
    };
}

function common(credential: PublicKeyCredential) {
    return {
        id: credential.id,
        rawId: bytesToBase64url(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults()
    };
}

/** A new credential → JSON for the server. */
export function registrationJson(credential: PublicKeyCredential) {
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
        ...common(credential),
        response: {
            clientDataJSON: bytesToBase64url(response.clientDataJSON),
            attestationObject: bytesToBase64url(response.attestationObject),
            transports: response.getTransports?.()
        }
    };
}

/** An assertion → JSON for the server. */
export function authenticationJson(credential: PublicKeyCredential) {
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
        ...common(credential),
        response: {
            clientDataJSON: bytesToBase64url(response.clientDataJSON),
            authenticatorData: bytesToBase64url(response.authenticatorData),
            signature: bytesToBase64url(response.signature),
            userHandle:
                response.userHandle === null ? undefined : bytesToBase64url(response.userHandle)
        }
    };
}

export function isWebAuthnSupported(): boolean {
    return typeof globalThis.PublicKeyCredential === 'function' && !!navigator.credentials;
}
