// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    const ns = self.libsignal = self.libsignal || {};

    const whisperText = ns.util.stringToArrayBuffer("WhisperText");
    const whisperRatchet = ns.util.stringToArrayBuffer("WhisperRatchet");


    ns.SessionBuilder = class SessionBuilder {

        constructor(storage, remoteAddress) {
            this.remoteAddress = remoteAddress;
            this.storage = storage;
        }

        async processPreKey(device) {
            const addr = this.remoteAddress.toString();
            return await ns.queueJob(addr, async () => {
                const trusted = await this.storage.isTrustedIdentity(addr, device.identityKey);
                if (!trusted) {
                    throw new ns.UntrustedIdentityKeyError({addr, identityKey: device.identityKey});
                }
                ns.curve.verifySignature(device.identityKey, device.signedPreKey.publicKey,
                                         device.signedPreKey.signature);
                const baseKey = ns.curve.generateKeyPair();
                let devicePreKey;
                if (device.preKey) {
                    devicePreKey = device.preKey.publicKey;
                }
                const session = await this.initSession(true, baseKey, undefined, device.identityKey,
                                                       devicePreKey, device.signedPreKey.publicKey,
                                                       device.registrationId);
                session.pendingPreKey = {
                    signedKeyId: device.signedPreKey.keyId,
                    baseKey: baseKey.pubKey
                };
                if (device.preKey) {
                    session.pendingPreKey.preKeyId = device.preKey.keyId;
                }
                const data = await this.storage.loadSession(addr);
                const record = ns.SessionRecord.fromStorage(data);
                record.archiveCurrentState();
                record.updateSessionState(session);
                await this.storage.storeSession(addr, record);
                await this.storage.saveIdentity(addr, session.indexInfo.remoteIdentityKey);
            });
        }

        async processV3(record, message) {
            const addr = this.remoteAddress.toString();
            const msgIdentityKey = message.identityKey.toArrayBuffer();
            const trusted = await this.storage.isTrustedIdentity(addr, msgIdentityKey);
            if (!trusted) {
                throw new ns.UntrustedIdentityKeyError({addr, message, identityKey: msgIdentityKey});
            }
            const preKeyPair = await this.storage.loadPreKey(message.preKeyId);
            const signedPreKeyPair = await this.storage.loadSignedPreKey(message.signedPreKeyId);
            const baseKey = message.baseKey.toArrayBuffer();
            let session = record.getSession(baseKey);
            if (session) {
                console.debug("Duplicate PreKeyMessage for session");
                return;
            }
            session = record.getOpenSession();
            if (signedPreKeyPair === undefined) {
                // Session may or may not be the right one, but if its not, we
                // can't do anything about it ...fall through and let
                // decryptWhisperMessage handle that case
                if (session !== undefined && session.currentRatchet !== undefined) {
                    return;
                } else {
                    throw new ns.PreKeyError("Missing SignedPreKey");
                }
            }
            if (session !== undefined) {
                record.archiveCurrentState();
            }
            if (message.preKeyId && !preKeyPair) {
                throw new ns.PreKeyError('Invalid PreKey ID');
            }
            const newSession = await this.initSession(false, preKeyPair, signedPreKeyPair,
                                                      msgIdentityKey, baseKey, undefined,
                                                      message.registrationId);
            // Note that the session is not actually saved until the very
            // end of decryptWhisperMessage ... to ensure that the sender
            // actually holds the private keys for all reported pubkeys
            record.updateSessionState(newSession);
            await this.storage.saveIdentity(addr, msgIdentityKey);
            return message.preKeyId;
        }

        async initSession(isInitiator, ourEphemeralKey, ourSignedKey, theirIdentityPubKey,
                          theirEphemeralPubKey, theirSignedPubKey, registrationId) {
            if (isInitiator) {
                if (ourSignedKey !== undefined) {
                    throw new Error("Invalid call to initSession");
                }
                ourSignedKey = ourEphemeralKey;
            } else {
                if (theirSignedPubKey !== undefined) {
                    throw new Error("Invalid call to initSession");
                }
                theirSignedPubKey = theirEphemeralPubKey;
            }
            let sharedSecret;
            if (ourEphemeralKey === undefined || theirEphemeralPubKey === undefined) {
                sharedSecret = new Uint8Array(32 * 4);
            } else {
                sharedSecret = new Uint8Array(32 * 5);
            }
            for (let i = 0; i < 32; i++) {
                sharedSecret[i] = 0xff;
            }
            const ourIdentityKey = await this.storage.getIdentityKeyPair();
            const ecRes = [
                ns.curve.calculateAgreement(theirSignedPubKey, ourIdentityKey.privKey),
                ns.curve.calculateAgreement(theirIdentityPubKey, ourSignedKey.privKey),
                ns.curve.calculateAgreement(theirSignedPubKey, ourSignedKey.privKey)
            ];
            if (isInitiator) {
                sharedSecret.set(new Uint8Array(ecRes[0]), 32);
                sharedSecret.set(new Uint8Array(ecRes[1]), 32 * 2);
            } else {
                sharedSecret.set(new Uint8Array(ecRes[0]), 32 * 2);
                sharedSecret.set(new Uint8Array(ecRes[1]), 32);
            }
            sharedSecret.set(new Uint8Array(ecRes[2]), 32 * 3);
            if (ourEphemeralKey !== undefined && theirEphemeralPubKey !== undefined) {
                const ecRes4 = ns.curve.calculateAgreement(theirEphemeralPubKey,
                                                           ourEphemeralKey.privKey);
                sharedSecret.set(new Uint8Array(ecRes4), 32 * 4);
            }
            const masterKey = await ns.crypto.deriveSecrets(sharedSecret.buffer, new ArrayBuffer(32), whisperText);
            const session = {
                registrationId: registrationId,
                currentRatchet: {
                    rootKey: masterKey[0],
                    lastRemoteEphemeralKey: theirSignedPubKey,
                    previousCounter: 0
                },
                indexInfo: {
                    remoteIdentityKey: theirIdentityPubKey,
                    closed: -1
                },
                chains: new ns.ArrayBufferMap()
            };
            // If we're initiating we go ahead and set our first sending ephemeral key now,
            // otherwise we figure it out when we first maybeStepRatchet with the remote's ephemeral key
            if (isInitiator) {
                session.indexInfo.baseKey = ourEphemeralKey.pubKey;
                session.indexInfo.baseKeyType = ns.BaseKeyType.OURS;
                const ourSendingEphemeralKey = ns.curve.generateKeyPair();
                session.currentRatchet.ephemeralKeyPair = ourSendingEphemeralKey;
                await this.calculateSendingRatchet(session, theirSignedPubKey);
            } else {
                session.indexInfo.baseKey = theirEphemeralPubKey;
                session.indexInfo.baseKeyType = ns.BaseKeyType.THEIRS;
                session.currentRatchet.ephemeralKeyPair = ourSignedKey;
            }
            return session;
        }

        async calculateSendingRatchet(session, remoteKey) {
            const ratchet = session.currentRatchet;
            const sharedSecret = ns.curve.calculateAgreement(remoteKey, ratchet.ephemeralKeyPair.privKey);
            const masterKey = await ns.crypto.deriveSecrets(sharedSecret, ratchet.rootKey, whisperRatchet);
            session.chains.set(ratchet.ephemeralKeyPair.pubKey, {
                messageKeys: new Map(),
                chainKey: {
                    counter: -1,
                    key: masterKey[1]
                },
                chainType: ns.ChainType.SENDING
            });
            ratchet.rootKey = masterKey[0];
        }
    };
})();
