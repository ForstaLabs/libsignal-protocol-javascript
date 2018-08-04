// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    const ns = self.libsignal = self.libsignal || {};

    const whisperText = ns.util.stringToArrayBuffer("WhisperText");
    const whisperRatchet = ns.util.stringToArrayBuffer("WhisperRatchet");


    ns.SessionBuilder = class SessionBuilder {

        constructor(storage, protocolAddress) {
            this.addr = protocolAddress;
            this.storage = storage;
        }

        async initOutgoing(device) {
            const fqAddr = this.addr.toString();
            return await ns.queueJob(fqAddr, async () => {
                if (!await this.storage.isTrustedIdentity(this.addr.id, device.identityKey)) {
                    throw new ns.UntrustedIdentityKeyError(this.addr.id, device.identityKey);
                }
                ns.curve.verifySignature(device.identityKey, device.signedPreKey.publicKey,
                                         device.signedPreKey.signature);
                const baseKey = ns.curve.generateKeyPair();
                const devicePreKey = device.preKey && device.preKey.publicKey;
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
                const data = await this.storage.loadSession(fqAddr);
                const record = ns.SessionRecord.fromStorage(data);
                const openSession = record.getOpenSession();
                if (openSession) {
                    console.warn("Closing stale open session for new outgoing prekey bundle");
                    record.closeSession(openSession);
                }
                record.setSession(session);
                await this.storage.storeSession(fqAddr, record);
            });
        }

        async initIncoming(record, message) {
            const fqAddr = this.addr.toString();
            const msgIdentityKey = message.identityKey.toArrayBuffer();
            if (!await this.storage.isTrustedIdentity(this.addr.id, msgIdentityKey)) {
                throw new ns.UntrustedIdentityKeyError(this.addr.id, msgIdentityKey);
            }
            const baseKey = message.baseKey.toArrayBuffer();
            if (record.getSession(baseKey)) {
                // This just means we haven't replied.
                return;
            }
            const preKeyPair = await this.storage.loadPreKey(message.preKeyId);
            if (message.preKeyId && !preKeyPair) {
                throw new ns.PreKeyError('Invalid PreKey ID');
            }
            const signedPreKeyPair = await this.storage.loadSignedPreKey(message.signedPreKeyId);
            if (!signedPreKeyPair) {
                throw new ns.PreKeyError("Missing SignedPreKey");
            }
            const existingOpenSession = record.getOpenSession();
            if (existingOpenSession) {
                console.warn("Closing open session in favor of incoming prekey bundle");
                record.closeSession(existingOpenSession);
            }
            record.setSession(await this.initSession(false, preKeyPair, signedPreKeyPair,
                                                     msgIdentityKey, baseKey, undefined,
                                                     message.registrationId));
            return message.preKeyId;
        }

        async initSession(isInitiator, ourEphemeralKey, ourSignedKey, theirIdentityPubKey,
                          theirEphemeralPubKey, theirSignedPubKey, registrationId) {
            if (isInitiator) {
                if (ourSignedKey) {
                    throw new Error("Invalid call to initSession");
                }
                ourSignedKey = ourEphemeralKey;
            } else {
                if (theirSignedPubKey) {
                    throw new Error("Invalid call to initSession");
                }
                theirSignedPubKey = theirEphemeralPubKey;
            }
            let sharedSecret;
            if (!ourEphemeralKey || !theirEphemeralPubKey) {
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
            if (ourEphemeralKey && theirEphemeralPubKey) {
                const ecRes4 = ns.curve.calculateAgreement(theirEphemeralPubKey,
                                                           ourEphemeralKey.privKey);
                sharedSecret.set(new Uint8Array(ecRes4), 32 * 4);
            }
            const masterKey = await ns.crypto.deriveSecrets(sharedSecret.buffer, new ArrayBuffer(32),
                                                            whisperText);
            const session = {
                registrationId,
                currentRatchet: {
                    rootKey: masterKey[0],
                    ephemeralKeyPair: isInitiator ? ns.curve.generateKeyPair() : ourSignedKey,
                    lastRemoteEphemeralKey: theirSignedPubKey,
                    previousCounter: 0
                },
                indexInfo: {
                    created: Date.now(),
                    used: Date.now(),
                    remoteIdentityKey: theirIdentityPubKey,
                    baseKey: isInitiator ? ourEphemeralKey.pubKey : theirEphemeralPubKey,
                    baseKeyType: isInitiator ? ns.BaseKeyType.OURS : ns.BaseKeyType.THEIRS,
                    closed: -1
                },
                chains: new ns.ArrayBufferMap()
            };
            if (isInitiator) {
                // If we're initiating we go ahead and set our first sending ephemeral key now,
                // otherwise we figure it out when we first maybeStepRatchet with the remote's
                // ephemeral key
                await this.calculateSendingRatchet(session, theirSignedPubKey);
            }
            console.info((isInitiator ? "Created" : "Imported") + " new session:", session);
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
