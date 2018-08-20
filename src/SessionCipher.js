// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';
    
    const ns = self.libsignal = self.libsignal || {};

    const whisperMessageKeys = ns.util.stringToArrayBuffer("WhisperMessageKeys");
    const whisperRatchet = ns.util.stringToArrayBuffer("WhisperRatchet");

    ns.SessionCipher = class SessionCipher {

        constructor(storage, protocolAddress) {
            if (!(protocolAddress instanceof libsignal.ProtocolAddress)) {
                throw new TypeError("protocolAddress must be a ProtocolAddress");
            }
            this.addr = protocolAddress;
            this.storage = storage;
        }

        toString() {
            return `<SessionCipher(${this.addr.toString()})>`;
        }

        async getRecord() {
            const data = await this.storage.loadSession(this.addr.toString());
            return data && ns.SessionRecord.fromStorage(data);
        }

        async storeRecord(record) {
            record.removeOldSessions();
            await this.storage.storeSession(this.addr.toString(), record);
        }

        async queueJob(awaitable) {
            return await ns.queueJob(this.addr.toString(), awaitable);
        }

        async encrypt(data) {
            if (!(data instanceof ArrayBuffer)) {
                throw new TypeError("ArrayBuffer required");
            }
            const ourIdentityKey = await this.storage.getIdentityKeyPair();
            return await this.queueJob(async () => {
                const record = await this.getRecord();
                if (!record) {
                    throw new ns.SessionError("No sessions");
                }
                const session = record.getOpenSession();
                if (!session) {
                    throw new ns.SessionError("No open session");
                }
                const remoteIdentityKey = session.indexInfo.remoteIdentityKey;
                if (!await this.storage.isTrustedIdentity(this.addr.id, remoteIdentityKey)) {
                    throw new ns.UntrustedIdentityKeyError(this.addr.id, remoteIdentityKey);
                }
                const chain = session.chains.get(session.currentRatchet.ephemeralKeyPair.pubKey);
                if (chain.chainType === ns.ChainType.RECEIVING) {
                    throw new TypeError("Tried to encrypt on a receiving chain");
                }
                await this.fillMessageKeys(chain, chain.chainKey.counter + 1);
                const keys = await ns.crypto.deriveSecrets(chain.messageKeys.get(chain.chainKey.counter),
                                                           new ArrayBuffer(32), whisperMessageKeys);
                chain.messageKeys.delete(chain.chainKey.counter);
                const msg = new ns.protobuf.WhisperMessage();
                msg.ephemeralKey = session.currentRatchet.ephemeralKeyPair.pubKey;
                msg.counter = chain.chainKey.counter;
                msg.previousCounter = session.currentRatchet.previousCounter;
                msg.ciphertext = await ns.crypto.encrypt(keys[0], data, keys[2].slice(0, 16));
                const msgBytes = new Uint8Array(msg.toArrayBuffer());
                const macInput = new Uint8Array(msgBytes.length + (33 * 2) + 1);
                macInput.set(new Uint8Array(ourIdentityKey.pubKey));
                macInput.set(new Uint8Array(remoteIdentityKey), 33);
                macInput[33 * 2] = (3 << 4) | 3;
                macInput.set(msgBytes, (33 * 2) + 1);
                const mac = await ns.crypto.calculateMAC(keys[1], macInput.buffer);
                const result = new Uint8Array(msgBytes.length + 9);
                result[0] = (3 << 4) | 3;
                result.set(msgBytes, 1);
                result.set(new Uint8Array(mac, 0, 8), msgBytes.length + 1);
                await this.storeRecord(record);
                let type, body;
                if (session.pendingPreKey) {
                    type = 3;  // prekey bundle
                    const preKeyMsg = new ns.protobuf.PreKeyWhisperMessage();
                    preKeyMsg.identityKey = ourIdentityKey.pubKey;
                    preKeyMsg.registrationId = await this.storage.getLocalRegistrationId();
                    preKeyMsg.baseKey = session.pendingPreKey.baseKey;
                    if (session.pendingPreKey.preKeyId) {
                        preKeyMsg.preKeyId = session.pendingPreKey.preKeyId;
                    }
                    preKeyMsg.signedPreKeyId = session.pendingPreKey.signedKeyId;
                    preKeyMsg.message = result;
                    const preKeyBytes = new Uint8Array(preKeyMsg.encode().toArrayBuffer());
                    body = String.fromCharCode((3 << 4) | 3) + ns.util.bytesToString(preKeyBytes);
                } else {
                    type = 1;  // normal
                    body = ns.util.bytesToString(result);
                }
                return {
                    type,
                    body,
                    registrationId: session.registrationId
                };
            });
        }

        async decryptWithSessions(data, sessions) {
            // Iterate through the sessions, attempting to decrypt using each one.
            // Stop and return the result if we get a valid result.
            if (!sessions.length) {
                throw new ns.SessionError("No sessions available");
            }
            const errors = [];
            for (const session of sessions) {
                let plaintext;
                try {
                    plaintext = await this.doDecryptWhisperMessage(data, session);
                    session.indexInfo.used = Date.now();
                    return {
                        session,
                        plaintext
                    };
                } catch(e) {
                    errors.push(e);
                }
            }
            console.error("Failed to decrypt message with any known session...");
            for (const e of errors) {
                console.error("Session error:" + e, e.stack);
            }
            throw new ns.SessionError("No matching sessions found for message", {decryptError: errors});
        }

        async decryptWhisperMessage(data) {
            return await this.queueJob(async () => {
                const record = await this.getRecord();
                if (!record) {
                    throw new ns.SessionError("No session record");
                }
                const result = await this.decryptWithSessions(data, record.getSessions());
                const remoteIdentityKey = result.session.indexInfo.remoteIdentityKey;
                if (!await this.storage.isTrustedIdentity(this.addr.id, remoteIdentityKey)) {
                    throw new ns.UntrustedIdentityKeyError(this.addr.id, remoteIdentityKey);
                }
                if (record.isClosed(result.session)) {
                    // It's possible for this to happen when processing a backlog of messages.
                    // The message was, hopefully, just sent back in a time when this session
                    // was the most current.  Simply make a note of it and continue.  If our
                    // actual open session is for reason invalid, that must be handled via
                    // a full SessionError response.
                    console.warn("Decrypted message with closed session.");
                }
                await this.storeRecord(record);
                return result.plaintext;
            });
        }

        async decryptPreKeyWhisperMessage(data) {
            if (!(data instanceof ArrayBuffer)) {
                throw new TypeError('ArrayBuffer required');
            }
            const version = (new Uint8Array(data))[0];
            if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
                throw new Error("Incompatible version number on PreKeyWhisperMessage");
            }
            return await this.queueJob(async () => {
                let record = await this.getRecord();
                const preKeyProto = ns.protobuf.PreKeyWhisperMessage.decode(data.slice(1));
                if (!record) {
                    if (preKeyProto.registrationId == null) {
                        throw new Error("No registrationId");
                    }
                    record = new ns.SessionRecord();
                }
                const builder = new libsignal.SessionBuilder(this.storage, this.addr);
                const preKeyId = await builder.initIncoming(record, preKeyProto);
                const session = record.getSession(preKeyProto.baseKey.toArrayBuffer());
                const plaintext = await this.doDecryptWhisperMessage(preKeyProto.message.toArrayBuffer(), session);
                await this.storeRecord(record);
                if (preKeyId) {
                    await this.storage.removePreKey(preKeyId);
                }
                return plaintext;
            });
        }

        async doDecryptWhisperMessage(messageBuffer, session) {
            if (!(messageBuffer instanceof ArrayBuffer)) {
                throw new TypeError("ArrayBuffer required");
            }
            if (!session) {
                throw new TypeError("session required");
            }
            const messageBytes = new Uint8Array(messageBuffer);
            const version = messageBytes[0];
            if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
                throw new Error("Incompatible version number on WhisperMessage");
            }
            const messageProto = messageBytes.slice(1, -8);
            const message = ns.protobuf.WhisperMessage.decode(messageProto);
            const ephemeralKey = message.ephemeralKey.toArrayBuffer();
            await this.maybeStepRatchet(session, ephemeralKey, message.previousCounter);
            const chain = session.chains.get(ephemeralKey);
            if (chain.chainType === ns.ChainType.SENDING) {
                throw new Error("Tried to decrypt on a sending chain");
            }
            await this.fillMessageKeys(chain, message.counter);
            if (!chain.messageKeys.has(message.counter)) {
                // Most likely the message was already decrypted and we are trying to process
                // twice.  This can happen if the user restarts before the server gets an ACK.
                throw new ns.MessageCounterError('Key used already or never filled');
            }
            const messageKey = chain.messageKeys.get(message.counter);
            chain.messageKeys.delete(message.counter);
            const keys = await ns.crypto.deriveSecrets(messageKey, new ArrayBuffer(32), whisperMessageKeys);
            const ourIdentityKey = await this.storage.getIdentityKeyPair();
            const macInput = new Uint8Array(messageProto.length + (33 * 2) + 1);
            macInput.set(new Uint8Array(session.indexInfo.remoteIdentityKey));
            macInput.set(new Uint8Array(ourIdentityKey.pubKey), 33);
            macInput[33 * 2] = (3 << 4) | 3;
            macInput.set(messageProto, (33 * 2) + 1);
            // This is where we most likely fail if the session is not a match.
            // Don't misinterpret this as corruption.
            await ns.crypto.verifyMAC(macInput.buffer, keys[1], messageBytes.slice(-8).buffer, 8);
            const plaintext = await ns.crypto.decrypt(keys[0], message.ciphertext.toArrayBuffer(),
                                                      keys[2].slice(0, 16));
            delete session.pendingPreKey;
            return plaintext;
        }

        async fillMessageKeys(chain, counter) {
            if (chain.chainKey.counter >= counter) {
                return;
            }
            if (counter - chain.chainKey.counter > 2000) {
                throw new ns.SessionError('Over 2000 messages into the future!');
            }
            if (!chain.chainKey.key) {
                throw new ns.SessionError('Chain closed');
            }
            const signed = await Promise.all([
                ns.crypto.calculateMAC(chain.chainKey.key, (new Uint8Array([1])).buffer),
                ns.crypto.calculateMAC(chain.chainKey.key, (new Uint8Array([2])).buffer)
            ]);
            chain.messageKeys.set(chain.chainKey.counter + 1, signed[0]);
            chain.chainKey.key = signed[1];
            chain.chainKey.counter += 1;
            return await this.fillMessageKeys(chain, counter);
        }

        async maybeStepRatchet(session, remoteKey, previousCounter) {
            if (session.chains.has(remoteKey)) {
                return;
            }
            const ratchet = session.currentRatchet;
            let previousRatchet = session.chains.get(ratchet.lastRemoteEphemeralKey);
            if (previousRatchet) {
                await this.fillMessageKeys(previousRatchet, previousCounter);
                delete previousRatchet.chainKey.key;  // Close
            }
            await this.calculateRatchet(session, remoteKey, false);
            // Now swap the ephemeral key and calculate the new sending chain
            const chainId = ratchet.ephemeralKeyPair.pubKey;
            if (session.chains.has(chainId)) {
                ratchet.previousCounter = session.chains.get(chainId).chainKey.counter;
                session.chains.delete(chainId);
            }
            ratchet.ephemeralKeyPair = ns.curve.generateKeyPair();
            await this.calculateRatchet(session, remoteKey, true);
            ratchet.lastRemoteEphemeralKey = remoteKey;
        }

        async calculateRatchet(session, remoteKey, sending) {
            const ratchet = session.currentRatchet;
            const sharedSecret = ns.curve.calculateAgreement(remoteKey, ratchet.ephemeralKeyPair.privKey);
            const masterKey = await ns.crypto.deriveSecrets(sharedSecret, ratchet.rootKey, whisperRatchet);
            const chainKey = sending ? ratchet.ephemeralKeyPair.pubKey : remoteKey;
            session.chains.set(chainKey, {
                messageKeys: new Map(),
                chainKey: {
                    counter: -1,
                    key: masterKey[1]
                },
                chainType: sending ? ns.ChainType.SENDING : ns.ChainType.RECEIVING
            });
            ratchet.rootKey = masterKey[0];
        }

        async hasOpenSession() {
            return await this.queueJob(async () => {
                const record = await this.getRecord();
                if (!record) {
                    return false;
                }
                return record.haveOpenSession();
            });
        }

        async closeOpenSession() {
            return await this.queueJob(async () => {
                const record = await this.getRecord();
                if (record) {
                    const openSession = record.getOpenSession();
                    if (openSession) {
                        record.closeSession(openSession);
                        await this.storeRecord(record);
                    }
                }
            });
        }
    };
})();
