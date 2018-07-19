/*
 * vim: ts=4:sw=4
 */

var Internal = Internal || {};

(function() {
    'use strict';

    const crypto = self.crypto;

    if (!crypto || !crypto.subtle || typeof crypto.getRandomValues !== 'function') {
        throw new Error('WebCrypto not found');
    }

    Internal.crypto = {
        getRandomBytes: function(size) {
            const array = new Uint8Array(size);
            crypto.getRandomValues(array);
            return array.buffer;
        },

        encrypt: async function(keyData, data, iv) {
            const key = await crypto.subtle.importKey('raw', keyData, {name: 'AES-CBC'}, false, ['encrypt']);
            return await crypto.subtle.encrypt({name: 'AES-CBC', iv: new Uint8Array(iv)}, key, data);
        },

        decrypt: async function(keyData, data, iv) {
            const key = await crypto.subtle.importKey('raw', keyData, {name: 'AES-CBC'}, false, ['decrypt']);
            return await crypto.subtle.decrypt({name: 'AES-CBC', iv: new Uint8Array(iv)}, key, data);
        },

        sign: async function(keyData, data) {
            const key = await crypto.subtle.importKey('raw', keyData, {
                name: 'HMAC',
                hash: {name: 'SHA-256'}
            }, false, ['sign']);
            return await crypto.subtle.sign({name: 'HMAC', hash: 'SHA-256'}, key, data);
        },

        hash: async function(data) {
            return await crypto.subtle.digest({name: 'SHA-512'}, data);
        },

        HKDF: async function(input, salt, info, chunks) {
            // Specific implementation of RFC 5869 that only returns the first 3 32-byte chunks
            chunks = chunks || 3;
            console.assert(chunks >= 1 && chunks <= 3);
            const PRK = await Internal.crypto.sign(salt, input);
            const infoBuffer = new ArrayBuffer(info.byteLength + 1 + 32);
            const infoArray = new Uint8Array(infoBuffer);
            infoArray.set(new Uint8Array(info), 32);
            infoArray[infoArray.length - 1] = 1;
            const signed = [await Internal.crypto.sign(PRK, infoBuffer.slice(32))];
            if (chunks > 1) {
                infoArray.set(new Uint8Array(signed[signed.length - 1]));
                infoArray[infoArray.length - 1] = 2;
                signed.push(await Internal.crypto.sign(PRK, infoBuffer));
            }
            if (chunks > 2) {
                infoArray.set(new Uint8Array(signed[signed.length - 1]));
                infoArray[infoArray.length - 1] = 3;
                signed.push(await Internal.crypto.sign(PRK, infoBuffer));
            }
            return signed;
        },

        // Curve 25519 crypto
        createKeyPair: function(privKey) {
            if (privKey === undefined) {
                privKey = Internal.crypto.getRandomBytes(32);
            }
            return Internal.Curve.async.createKeyPair(privKey);
        },
        ECDHE: function(pubKey, privKey) {
            return Internal.Curve.async.ECDHE(pubKey, privKey);
        },
        Ed25519Sign: function(privKey, message) {
            return Internal.Curve.async.Ed25519Sign(privKey, message);
        },
        Ed25519Verify: function(pubKey, msg, sig) {
            return Internal.Curve.async.Ed25519Verify(pubKey, msg, sig);
        }
    };


    // HKDF for TextSecure has a bit of additional handling - salts always end up being 32 bytes
    Internal.HKDF = function(input, salt, info) {
        if (salt.byteLength != 32) {
            throw new Error("Got salt of incorrect length");
        }

        return Internal.crypto.HKDF(input, salt,  util.toArrayBuffer(info));
    };

    Internal.verifyMAC = async function(data, key, mac, length) {
        const calculatedMac = await Internal.crypto.sign(key, data);
        if (mac.byteLength != length  || calculatedMac.byteLength < length) {
            throw new Error("Bad MAC length");
        }
        const a = new Uint8Array(calculatedMac);
        const b = new Uint8Array(mac);
        let result = 0;
        for (let i = 0; i < mac.byteLength; ++i) {
            result = result | (a[i] ^ b[i]);
        }
        if (result !== 0) {
            throw new Error("Bad MAC");
        }
    };

    libsignal.HKDF = {
        deriveSecrets: Internal.HKDF
    };

    libsignal.crypto = {
        encrypt: Internal.crypto.encrypt,
        decrypt: Internal.crypto.decrypt,
        calculateMAC: Internal.crypto.sign,
        verifyMAC: Internal.verifyMAC,
        getRandomBytes: Internal.crypto.getRandomBytes
    };
})();
