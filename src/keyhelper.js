// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    self.libsignal = self.libsignal || {};
    const ns = self.libsignal.keyhelper = {};

    function isNonNegativeInteger(n) {
        return (typeof n === 'number' && (n % 1) === 0  && n >= 0);
    }

    ns.generateIdentityKeyPair = libsignal.curve.generateKeyPair;

    ns.generateRegistrationId = function() {
        var registrationId = new Uint16Array(libsignal.crypto.getRandomBytes(2))[0];
        return registrationId & 0x3fff;
    };

    ns.generateSignedPreKey = async function(identityKeyPair, keyId) {
        if (!(identityKeyPair.privKey instanceof ArrayBuffer) ||
            identityKeyPair.privKey.byteLength != 32 ||
            !(identityKeyPair.pubKey instanceof ArrayBuffer) ||
            identityKeyPair.pubKey.byteLength != 33) {
            throw new TypeError('Invalid argument for identityKeyPair');
        }
        if (!isNonNegativeInteger(keyId)) {
            throw new TypeError('Invalid argument for keyId: ' + keyId);
        }
        const keyPair = await libsignal.curve.generateKeyPair();
        const signature = await libsignal.curve.calculateSignature(identityKeyPair.privKey, keyPair.pubKey);
        return {
            keyId,
            keyPair,
            signature
        };
    };

    ns.generatePreKey = async function(keyId) {
        if (!isNonNegativeInteger(keyId)) {
            throw new TypeError('Invalid argument for keyId: ' + keyId);
        }
        const keyPair = await libsignal.curve.generateKeyPair();
        return {
            keyId,
            keyPair
        };
    };
})();
