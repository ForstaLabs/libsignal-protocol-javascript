// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    self.libsignal = self.libsignal || {};
    const ns = self.libsignal.crypto = {};
    const subtle = self.crypto && self.crypto.subtle;

    ns.getRandomBytes = function(size) {
        const array = new Uint8Array(size);
        crypto.getRandomValues(array);
        return array.buffer;
    };

    ns.encrypt = async function(keyData, data, iv) {
        if (!(data instanceof ArrayBuffer)) {
            throw new TypeError("data must be ArrayBuffer");
        }
        const key = await subtle.importKey('raw', keyData, {name: 'AES-CBC'}, false, ['encrypt']);
        return await subtle.encrypt({name: 'AES-CBC', iv: new Uint8Array(iv)}, key, data);
    };

    ns.decrypt = async function(keyData, data, iv) {
        if (!(data instanceof ArrayBuffer)) {
            throw new TypeError("data must be ArrayBuffer");
        }
        const key = await subtle.importKey('raw', keyData, {name: 'AES-CBC'}, false, ['decrypt']);
        return await subtle.decrypt({name: 'AES-CBC', iv: new Uint8Array(iv)}, key, data);
    };

    ns.calculateMAC = async function(keyData, data) {
        if (!(keyData instanceof ArrayBuffer)) {
            throw new TypeError("keyData must be ArrayBuffer");
        }
        if (!(data instanceof ArrayBuffer)) {
            throw new TypeError("data must be ArrayBuffer");
        }
        const key = await subtle.importKey('raw', keyData, {
            name: 'HMAC',
            hash: {name: 'SHA-256'}
        }, false, ['sign']);
        return await subtle.sign({name: 'HMAC', hash: 'SHA-256'}, key, data);
    };

    ns.hash = async function(data) {
        if (!(data instanceof ArrayBuffer)) {
            throw new TypeError("data must be ArrayBuffer");
        }
        return await subtle.digest({name: 'SHA-512'}, data);
    };

    ns.deriveSecrets = async function(input, salt, info, chunks) {
        // Specific implementation of RFC 5869 that only returns the first 3 32-byte chunks
        if (!(input instanceof ArrayBuffer) ||
            !(salt instanceof ArrayBuffer) ||
            !(info instanceof ArrayBuffer)) {
            throw new TypeError('ArrayBuffer types required');
        }
        chunks = chunks || 3;
        console.assert(chunks >= 1 && chunks <= 3);
        const PRK = await ns.calculateMAC(salt, input);
        const infoBuffer = new ArrayBuffer(info.byteLength + 1 + 32);
        const infoArray = new Uint8Array(infoBuffer);
        infoArray.set(new Uint8Array(info), 32);
        infoArray[infoArray.length - 1] = 1;
        const signed = [await ns.calculateMAC(PRK, infoBuffer.slice(32))];
        if (chunks > 1) {
            infoArray.set(new Uint8Array(signed[signed.length - 1]));
            infoArray[infoArray.length - 1] = 2;
            signed.push(await ns.calculateMAC(PRK, infoBuffer));
        }
        if (chunks > 2) {
            infoArray.set(new Uint8Array(signed[signed.length - 1]));
            infoArray[infoArray.length - 1] = 3;
            signed.push(await ns.calculateMAC(PRK, infoBuffer));
        }
        return signed;
    };

    ns.verifyMAC = async function(data, key, mac, length) {
        const calculatedMac = await ns.calculateMAC(key, data);
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
})();
