// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';
    
    const ns = self.libsignal = self.libsignal || {};

    ns.SessionCipher = class SessionCipher {

        constructor(storage, remoteAddress) {
            this.remoteAddress = remoteAddress;
            this.storage = storage;
        }

        async getRecord(encodedNumber) {
            const serialized = await this.storage.loadSession(encodedNumber);
            return serialized && ns.SessionRecord.deserialize(serialized);
        }

        async encrypt(buffer, encoding) {
            buffer = dcodeIO.ByteBuffer.wrap(buffer, encoding).toArrayBuffer();
            if (!(buffer instanceof ArrayBuffer)) {
                throw new Error("Expected buffer to be an ArrayBuffer");
            }
            const addr = this.remoteAddress.toString();
            const ourIdentityKey = await this.storage.getIdentityKeyPair();
            return await ns.queueJob(addr, async () => {
                const record = await this.getRecord(addr);
                if (!record) {
                    throw new ns.SessionError("No record for " + addr);
                }
                const session = record.getOpenSession();
                if (!session) {
                    throw new ns.SessionError("No session to encrypt message for " + addr);
                }
                const remoteIdentityKey = ns.util.toArrayBuffer(session.indexInfo.remoteIdentityKey);
                const trusted = await this.storage.isTrustedIdentity(this.remoteAddress.getName(),
                                                                     remoteIdentityKey);
                if (!trusted) {
                    throw new ns.UntrustedIdentityKeyError({addr, identityKey: remoteIdentityKey});
                }
                await this.storage.saveIdentity(addr, session.indexInfo.remoteIdentityKey);
                const msg = new ns.protobuf.WhisperMessage();
                msg.ephemeralKey = ns.util.toArrayBuffer(session.currentRatchet.ephemeralKeyPair.pubKey);
                const chain = session[ns.util.toString(msg.ephemeralKey)];
                if (chain.chainType === ns.ChainType.RECEIVING) {
                    throw new ns.SessionError("Tried to encrypt on a receiving chain");
                }
                await this.fillMessageKeys(chain, chain.chainKey.counter + 1);
                const keys = await ns.crypto.deriveSecrets(ns.util.toArrayBuffer(chain.messageKeys[chain.chainKey.counter]),
                                                           new ArrayBuffer(32), ns.util.toArrayBuffer("WhisperMessageKeys"));
                delete chain.messageKeys[chain.chainKey.counter];
                msg.counter = chain.chainKey.counter;
                msg.previousCounter = session.currentRatchet.previousCounter;
                const ciphertext = await ns.crypto.encrypt(keys[0], buffer, keys[2].slice(0, 16));
                msg.ciphertext = ciphertext;
                const encodedMsg = msg.toArrayBuffer();
                const macInput = new Uint8Array(encodedMsg.byteLength + 33 * 2 + 1);
                macInput.set(new Uint8Array(ns.util.toArrayBuffer(ourIdentityKey.pubKey)));
                macInput.set(new Uint8Array(remoteIdentityKey), 33);
                macInput[33 * 2] = (3 << 4) | 3;
                macInput.set(new Uint8Array(encodedMsg), 33*2 + 1);
                const mac = await ns.crypto.calculateMAC(keys[1], macInput.buffer);
                const result = new Uint8Array(encodedMsg.byteLength + 9);
                result[0] = (3 << 4) | 3;
                result.set(new Uint8Array(encodedMsg), 1);
                result.set(new Uint8Array(mac, 0, 8), encodedMsg.byteLength + 1);
                await this.storage.saveIdentity(addr, session.indexInfo.remoteIdentityKey);
                record.updateSessionState(session);
                await this.storage.storeSession(addr, record.serialize());
                let type, body;
                if (session.pendingPreKey !== undefined) {
                    type = 3;  // prekey bundle
                    const preKeyMsg = new ns.protobuf.PreKeyWhisperMessage();
                    preKeyMsg.identityKey = ns.util.toArrayBuffer(ourIdentityKey.pubKey);
                    preKeyMsg.registrationId = await this.storage.getLocalRegistrationId();
                    preKeyMsg.baseKey = ns.util.toArrayBuffer(session.pendingPreKey.baseKey);
                    if (session.pendingPreKey.preKeyId) {
                        preKeyMsg.preKeyId = session.pendingPreKey.preKeyId;
                    }
                    preKeyMsg.signedPreKeyId = session.pendingPreKey.signedKeyId;
                    preKeyMsg.message = result;
                    body = String.fromCharCode((3 << 4) | 3) + ns.util.toString(preKeyMsg.encode());
                } else {
                    type = 1;  // normal
                    body = ns.util.toString(result);
                }
                return {
                    type,
                    body,
                    registrationId: session.registrationId
                };
            });
        }

        async decryptWithSessionList(buffer, sessions) {
            // Iterate through the sessions, attempting to decrypt using each one.
            // Stop and return the result if we get a valid result.
            const errors = [];
            for (const session of sessions) {
                try {
                    return {
                        plaintext: await this.doDecryptWhisperMessage(buffer, session),
                        session
                    };
                } catch(e) {
                    if (e.name === 'MessageCounterError') {
                        throw e;  // Dup;  Probably didn't dequeue the msg from the server successfully.
                    }
                    console.debug("Session decrypt failure:", e);
                    errors.push(e);
                }
            }
            throw (errors[0] || (new ReferenceError("No sessions to decrypt with")));
        }

        async decryptWhisperMessage(buffer, encoding) {
            buffer = dcodeIO.ByteBuffer.wrap(buffer, encoding).toArrayBuffer();
            const addr = this.remoteAddress.toString();
            return await ns.queueJob(addr, async () => {
                let record = await this.getRecord(addr);
                if (!record) {
                    throw new Error("No record for device " + addr);
                }
                const result = await this.decryptWithSessionList(buffer, record.getSessions());
                record = await this.getRecord(addr);  // Get ratcheted record.
                const openSession = record.getOpenSession();
                if (openSession && result.session.indexInfo.baseKey !== openSession.indexInfo.baseKey) {
                    record.archiveCurrentState();
                    record.promoteState(result.session);
                }
                const trusted = await this.storage.isTrustedIdentity(this.remoteAddress.getName(),
                    ns.util.toArrayBuffer(result.session.indexInfo.remoteIdentityKey));
                if (!trusted) {
                    throw new Error('Identity key changed');
                }
                await this.storage.saveIdentity(addr, result.session.indexInfo.remoteIdentityKey);
                record.updateSessionState(result.session);
                await this.storage.storeSession(addr, record.serialize());
                return result.plaintext;
            });
        }

        async decryptPreKeyWhisperMessage(buffer, encoding) {
            buffer = dcodeIO.ByteBuffer.wrap(buffer, encoding);
            const version = buffer.readUint8();
            if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
                throw new Error("Incompatible version number on PreKeyWhisperMessage");
            }
            const addr = this.remoteAddress.toString();
            return await ns.queueJob(addr, async () => {
                let record = await this.getRecord(addr);
                const preKeyProto = ns.protobuf.PreKeyWhisperMessage.decode(buffer);
                if (!record) {
                    if (preKeyProto.registrationId === undefined) {
                        throw new Error("No registrationId");
                    }
                    record = new ns.SessionRecord(preKeyProto.registrationId);
                }
                const builder = new libsignal.SessionBuilder(this.storage, this.remoteAddress);
                // isTrustedIdentity is called within processV3, no need to call it here
                const preKeyId = await builder.processV3(record, preKeyProto);
                const session = record.getSessionByBaseKey(preKeyProto.baseKey);
                const plaintext = await this.doDecryptWhisperMessage(preKeyProto.message.toArrayBuffer(), session);
                record.updateSessionState(session);
                await this.storage.storeSession(addr, record.serialize());
                if (preKeyId !== undefined && preKeyId !== null) {
                    await this.storage.removePreKey(preKeyId);
                }
                return plaintext;
            });
        }

        async doDecryptWhisperMessage(messageBytes, session) {
            if (!(messageBytes instanceof ArrayBuffer)) {
                throw new Error("Expected messageBytes to be an ArrayBuffer");
            }
            const version = (new Uint8Array(messageBytes))[0];
            if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
                throw new Error("Incompatible version number on WhisperMessage");
            }
            const messageProto = messageBytes.slice(1, messageBytes.byteLength- 8);
            const mac = messageBytes.slice(messageBytes.byteLength - 8, messageBytes.byteLength);
            const message = ns.protobuf.WhisperMessage.decode(messageProto);
            const remoteEphemeralKey = message.ephemeralKey.toArrayBuffer();
            if (session === undefined) {
                throw new Error("No session found to decrypt message from " + this.remoteAddress.toString());
            }
            if (session.indexInfo.closed != -1) {
                console.warn('decrypting message for closed session');
            }
            await this.maybeStepRatchet(session, remoteEphemeralKey, message.previousCounter);
            const chain = session[ns.util.toString(message.ephemeralKey)];
            if (chain.chainType === ns.ChainType.SENDING) {
                throw new Error("Tried to decrypt on a sending chain");
            }
            await this.fillMessageKeys(chain, message.counter);
            const messageKey = chain.messageKeys[message.counter];
            if (messageKey === undefined) {
                const e = new Error("Message key not found. The counter was repeated or the key was not filled.");
                e.name = 'MessageCounterError';
                throw e;
            }
            delete chain.messageKeys[message.counter];
            const keys = await ns.crypto.deriveSecrets(ns.util.toArrayBuffer(messageKey), new ArrayBuffer(32),
                                                       ns.util.toArrayBuffer("WhisperMessageKeys"));
            const ourIdentityKey = await this.storage.getIdentityKeyPair();
            const macInput = new Uint8Array(messageProto.byteLength + 33*2 + 1);
            macInput.set(new Uint8Array(ns.util.toArrayBuffer(session.indexInfo.remoteIdentityKey)));
            macInput.set(new Uint8Array(ns.util.toArrayBuffer(ourIdentityKey.pubKey)), 33);
            macInput[33*2] = (3 << 4) | 3;
            macInput.set(new Uint8Array(messageProto), 33*2 + 1);
            await ns.verifyMAC(macInput.buffer, keys[1], mac, 8);
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
                throw new Error('Over 2000 messages into the future!');
            }
            if (chain.chainKey.key === undefined) {
                throw new Error("Got invalid request to extend chain after it was already closed");
            }
            const key = ns.util.toArrayBuffer(chain.chainKey.key);
            const signed = await Promise.all([
                ns.crypto.calculateMAC(key, (new Uint8Array([1])).buffer),
                ns.crypto.calculateMAC(key, (new Uint8Array([2])).buffer)
            ]);
            chain.messageKeys[chain.chainKey.counter + 1] = signed[0];
            chain.chainKey.key = signed[1];
            chain.chainKey.counter += 1;
            return await this.fillMessageKeys(chain, counter);
        }

        async maybeStepRatchet(session, remoteKey, previousCounter) {
            if (session[ns.util.toString(remoteKey)] !== undefined) {
                return;
            }
            const ratchet = session.currentRatchet;
            let previousRatchet = session[ns.util.toString(ratchet.lastRemoteEphemeralKey)];
            if (previousRatchet !== undefined) {
                await this.fillMessageKeys(previousRatchet, previousCounter);
                delete previousRatchet.chainKey.key;
                session.oldRatchetList[session.oldRatchetList.length] = {
                    added: Date.now(),
                    ephemeralKey: ratchet.lastRemoteEphemeralKey
                };
            }
            await this.calculateRatchet(session, remoteKey, false);
            // Now swap the ephemeral key and calculate the new sending chain
            previousRatchet = ns.util.toString(ratchet.ephemeralKeyPair.pubKey);
            if (session[previousRatchet] !== undefined) {
                ratchet.previousCounter = session[previousRatchet].chainKey.counter;
                delete session[previousRatchet];
            }
            const keyPair = ns.curve.generateKeyPair();
            ratchet.ephemeralKeyPair = keyPair;
            await this.calculateRatchet(session, remoteKey, true);
            ratchet.lastRemoteEphemeralKey = remoteKey;
        }

        async calculateRatchet(session, remoteKey, sending) {
            const ratchet = session.currentRatchet;
            const sharedSecret = await ns.crypto.ECDHE(remoteKey,
                ns.util.toArrayBuffer(ratchet.ephemeralKeyPair.privKey));
            const masterKey = await ns.crypto.deriveSecrets(sharedSecret, ns.util.toArrayBuffer(ratchet.rootKey),
                                                            ns.util.toArrayBuffer("WhisperRatchet"));
            const ephemeralPublicKey = sending ? ratchet.ephemeralKeyPair.pubKey : remoteKey;
            session[ns.util.toString(ephemeralPublicKey)] = {
                messageKeys: {},
                chainKey: {
                    counter: -1,
                    key: masterKey[1]
                },
                chainType: sending ? ns.ChainType.SENDING : ns.ChainType.RECEIVING
            };
            ratchet.rootKey = masterKey[0];
        }

        async getRemoteRegistrationId() {
            const addr = this.remoteAddress.toString();
            return await ns.queueJob(addr, async () => {
                const record = await this.getRecord(addr);
                if (record === undefined) {
                    return undefined;
                }
                const openSession = record.getOpenSession();
                if (openSession === undefined) {
                    return null;
                }
                return openSession.registrationId;
            });
        }

        async hasOpenSession() {
            const addr = this.remoteAddress.toString();
            return await ns.queueJob(addr, async () => {
                const record = await this.getRecord(addr);
                if (record === undefined) {
                    return false;
                }
                return record.haveOpenSession();
            });
        }

        async closeOpenSessionForDevice() {
            const addr = this.remoteAddress.toString();
            return await ns.queueJob(addr, async () => {
                const record = await this.getRecord(addr);
                if (record === undefined || record.getOpenSession() === undefined) {
                    return;
                }
                record.archiveCurrentState();
                await this.storage.storeSession(addr, record.serialize());
            });
        }

        async deleteAllSessionsForDevice() {
            // Used in session reset scenarios, where we really need to delete
            const addr = this.remoteAddress.toString();
            await ns.queueJob(addr, async () => {
                const record = await this.getRecord(addr);
                if (record === undefined) {
                    return;
                }
                record.deleteAllSessions();
                await this.storage.storeSession(addr, record.serialize());
            });
        }
    };
})();
