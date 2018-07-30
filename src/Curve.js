// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    self.libsignal = self.libsignal || {};
    const ns = self.libsignal.curve = {};

    function validatePrivKey(privKey) {
        if (privKey === undefined || !(privKey instanceof ArrayBuffer) || privKey.byteLength != 32) {
            throw new Error("Invalid private key");
        }
    }

    function validatePubKeyFormat(pubKey) {
        if (pubKey === undefined ||
            ((pubKey.byteLength != 33 || new Uint8Array(pubKey)[0] != 5) &&
             pubKey.byteLength != 32)) {
            throw new Error("Invalid public key");
        }
        if (pubKey.byteLength == 33) {
            return pubKey.slice(1);
        } else {
            console.error("WARNING: Expected pubkey of length 33");
            return pubKey;
        }
    }

    function processKeys(raw_keys) {
        // prepend version byte
        var origPub = new Uint8Array(raw_keys.pubKey);
        var pub = new Uint8Array(33);
        pub.set(origPub, 1);
        pub[0] = 5;
        return {
            pubKey: pub.buffer,
            privKey: raw_keys.privKey
        };
    }

    ns.createKeyPair = function(privKey) {
        validatePrivKey(privKey);
        return processKeys(libsignal.curve25519.keyPair(privKey));
    },

    ns.calculateAgreement = function(pubKey, privKey) {
        pubKey = validatePubKeyFormat(pubKey);
        validatePrivKey(privKey);
        if (pubKey === undefined || pubKey.byteLength != 32) {
            throw new Error("Invalid public key");
        }
        return libsignal.curve25519.sharedSecret(pubKey, privKey);
    };

    ns.calculateSignature = function(privKey, message) {
        validatePrivKey(privKey);
        if (message === undefined) {
            throw new Error("Invalid message");
        }
        return libsignal.curve25519.sign(privKey, message);
    };

    ns.verifySignautre = function(pubKey, msg, sig) {
        pubKey = validatePubKeyFormat(pubKey);
        if (pubKey === undefined || pubKey.byteLength != 32) {
            throw new Error("Invalid public key");
        }
        if (msg === undefined) {
            throw new Error("Invalid message");
        }
        if (sig === undefined || sig.byteLength != 64) {
            throw new Error("Invalid signature");
        }
        libsignal.curve25519.verify(pubKey, msg, sig);
    };

    ns.generateKeyPair = function() {
        var privKey = ns.crypto.getRandomBytes(32);
        return ns.createKeyPair(privKey);
    };
})();
