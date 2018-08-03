// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    self.libsignal = self.libsignal || {};
    const ns = self.libsignal.curve = {};

    function validatePrivKey(privKey) {
        if (!privKey || !(privKey instanceof ArrayBuffer) || privKey.byteLength != 32) {
            throw new Error("Invalid private key");
        }
    }

    function scrubPubKeyFormat(pubKey) {
        if (!(pubKey instanceof ArrayBuffer)) {
            throw new TypeError("ArrayBuffer required");
        }
        if ((pubKey.byteLength !== 33 || new Uint8Array(pubKey)[0] !== 5) &&
             pubKey.byteLength !== 32) {
            throw new Error("Invalid public key");
        }
        if (pubKey.byteLength === 33) {
            return pubKey.slice(1);
        } else {
            console.error("WARNING: Expected pubkey of length 33");
            return pubKey;
        }
    }

    ns.createKeyPair = function(privKey) {
        validatePrivKey(privKey);
        const keys = libsignal.curve25519.keyPair(privKey);
        // prepend version byte
        const origPub = new Uint8Array(keys.pubKey);
        const pub = new Uint8Array(33);
        pub.set(origPub, 1);
        pub[0] = 5;
        return {
            pubKey: pub.buffer,
            privKey: keys.privKey
        };

    },

    ns.calculateAgreement = function(pubKey, privKey) {
        pubKey = scrubPubKeyFormat(pubKey);
        validatePrivKey(privKey);
        if (!pubKey || pubKey.byteLength !== 32) {
            throw new Error("Invalid public key");
        }
        return libsignal.curve25519.sharedSecret(pubKey, privKey);
    };

    ns.calculateSignature = function(privKey, message) {
        validatePrivKey(privKey);
        if (!message) {
            throw new Error("Invalid message");
        }
        return libsignal.curve25519.sign(privKey, message);
    };

    ns.verifySignature = function(pubKey, msg, sig) {
        pubKey = scrubPubKeyFormat(pubKey);
        if (!pubKey || pubKey.byteLength !== 32) {
            throw new Error("Invalid public key");
        }
        if (!msg) {
            throw new Error("Invalid message");
        }
        if (!sig || sig.byteLength !== 64) {
            throw new Error("Invalid signature");
        }
        libsignal.curve25519.verify(pubKey, msg, sig);
    };

    ns.generateKeyPair = function() {
        var privKey = libsignal.crypto.getRandomBytes(32);
        return ns.createKeyPair(privKey);
    };
})();
