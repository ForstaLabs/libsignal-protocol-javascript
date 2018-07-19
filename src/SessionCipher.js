// vim: ts=2:sw=2:expandtab

function SessionCipher(storage, remoteAddress) {
  this.remoteAddress = remoteAddress;
  this.storage = storage;
}

SessionCipher.prototype = {
  getRecord: async function(encodedNumber) {
    const serialized = await this.storage.loadSession(encodedNumber);
    return serialized && Internal.SessionRecord.deserialize(serialized);
  },

  encrypt: async function(buffer, encoding) {
    buffer = dcodeIO.ByteBuffer.wrap(buffer, encoding).toArrayBuffer();
    if (!(buffer instanceof ArrayBuffer)) {
        throw new Error("Expected buffer to be an ArrayBuffer");
    }
    const address = this.remoteAddress.toString();
    const ourIdentityKey = await this.storage.getIdentityKeyPair();
    return await Internal.SessionLock.queueJobForNumber(address, async () => {
      const record = await this.getRecord(address);
      if (!record) {
          throw new Error("No record for " + address);
      }
      const session = record.getOpenSession();
      if (!session) {
        throw new Error("No session to encrypt message for " + address);
      }
      const msg = new Internal.protobuf.WhisperMessage();
      msg.ephemeralKey = util.toArrayBuffer(
        session.currentRatchet.ephemeralKeyPair.pubKey
      );
      const chain = session[util.toString(msg.ephemeralKey)];
      if (chain.chainType === Internal.ChainType.RECEIVING) {
        throw new Error("Tried to encrypt on a receiving chain");
      }
      await this.fillMessageKeys(chain, chain.chainKey.counter + 1);
      const keys = await Internal.HKDF(util.toArrayBuffer(chain.messageKeys[chain.chainKey.counter]),
                                       new ArrayBuffer(32), "WhisperMessageKeys");
      delete chain.messageKeys[chain.chainKey.counter];
      msg.counter = chain.chainKey.counter;
      msg.previousCounter = session.currentRatchet.previousCounter;
      const ciphertext = await Internal.crypto.encrypt(keys[0], buffer, keys[2].slice(0, 16));
      msg.ciphertext = ciphertext;
      const encodedMsg = msg.toArrayBuffer();
      const macInput = new Uint8Array(encodedMsg.byteLength + 33 * 2 + 1);
      macInput.set(new Uint8Array(util.toArrayBuffer(ourIdentityKey.pubKey)));
      macInput.set(new Uint8Array(util.toArrayBuffer(session.indexInfo.remoteIdentityKey)), 33);
      macInput[33 * 2] = (3 << 4) | 3;
      macInput.set(new Uint8Array(encodedMsg), 33*2 + 1);
      const mac = await Internal.crypto.sign(keys[1], macInput.buffer);
      const result = new Uint8Array(encodedMsg.byteLength + 9);
      result[0] = (3 << 4) | 3;
      result.set(new Uint8Array(encodedMsg), 1);
      result.set(new Uint8Array(mac, 0, 8), encodedMsg.byteLength + 1);
      const trusted = await this.storage.isTrustedIdentity(this.remoteAddress.getName(),
                                                           util.toArrayBuffer(session.indexInfo.remoteIdentityKey));
      if (!trusted) {
        throw new Error('Identity key changed');
      }
      await this.storage.saveIdentity(address, session.indexInfo.remoteIdentityKey);
      record.updateSessionState(session);
      await this.storage.storeSession(address, record.serialize());
      let type, body;
      if (session.pendingPreKey !== undefined) {
        type = 3;  // prekey bundle
        const preKeyMsg = new Internal.protobuf.PreKeyWhisperMessage();
        preKeyMsg.identityKey = util.toArrayBuffer(ourIdentityKey.pubKey);
        preKeyMsg.registrationId = await this.storage.getLocalRegistrationId();
        preKeyMsg.baseKey = util.toArrayBuffer(session.pendingPreKey.baseKey);
        if (session.pendingPreKey.preKeyId) {
          preKeyMsg.preKeyId = session.pendingPreKey.preKeyId;
        }
        preKeyMsg.signedPreKeyId = session.pendingPreKey.signedKeyId;
        preKeyMsg.message = result;
        body = String.fromCharCode((3 << 4) | 3) + util.toString(preKeyMsg.encode());
      } else {
        type = 1;  // normal
        body = util.toString(result);
      }
      return {
        type,
        body,
        registrationId: session.registrationId
      };
    });
  },

  decryptWithSessionList: async function(buffer, sessionList, errors) {
    // Iterate recursively through the list, attempting to decrypt
    // using each one at a time. Stop and return the result if we get
    // a valid result
    errors = errors || [];
    if (sessionList.length === 0) {
      throw errors[0];
    }
    const session = sessionList.pop();
    try {
      const plaintext = await this.doDecryptWhisperMessage(buffer, session);
      return {plaintext, session};
    } catch(e) {
      if (e.name === 'MessageCounterError') {
          throw e;
      }
      errors.push(e);
      return await this.decryptWithSessionList(buffer, sessionList, errors);
    }
  },

  decryptWhisperMessage: async function(buffer, encoding) {
    buffer = dcodeIO.ByteBuffer.wrap(buffer, encoding).toArrayBuffer();
    const address = this.remoteAddress.toString();
    return await Internal.SessionLock.queueJobForNumber(address, async () => {
      let record = await this.getRecord(address);
      if (!record) {
        throw new Error("No record for device " + address);
      }
      const result = await this.decryptWithSessionList(buffer, record.getSessions());
      record = await this.getRecord(address);  // Get ratcheted record.
      if (result.session.indexInfo.baseKey !== record.getOpenSession().indexInfo.baseKey) {
        record.archiveCurrentState();
        record.promoteState(result.session);
      }
      const trusted = await this.storage.isTrustedIdentity(this.remoteAddress.getName(),
        util.toArrayBuffer(result.session.indexInfo.remoteIdentityKey));
      if (!trusted) {
        throw new Error('Identity key changed');
      }
      await this.storage.saveIdentity(address, result.session.indexInfo.remoteIdentityKey);
      record.updateSessionState(result.session);
      await this.storage.storeSession(address, record.serialize());
      return result.plaintext;
    });
  },

  decryptPreKeyWhisperMessage: async function(buffer, encoding) {
    buffer = dcodeIO.ByteBuffer.wrap(buffer, encoding);
    const version = buffer.readUint8();
    if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
        throw new Error("Incompatible version number on PreKeyWhisperMessage");
    }
    const address = this.remoteAddress.toString();
    return await Internal.SessionLock.queueJobForNumber(address, async () => {
      let record = await this.getRecord(address);
      const preKeyProto = Internal.protobuf.PreKeyWhisperMessage.decode(buffer);
      if (!record) {
        if (preKeyProto.registrationId === undefined) {
          throw new Error("No registrationId");
        }
        record = new Internal.SessionRecord(preKeyProto.registrationId);
      }
      const builder = new libsignal.SessionBuilder(this.storage, this.remoteAddress);
      // isTrustedIdentity is called within processV3, no need to call it here
      const preKeyId = await builder.processV3(record, preKeyProto);
      const session = record.getSessionByBaseKey(preKeyProto.baseKey);
      const plaintext = await this.doDecryptWhisperMessage(preKeyProto.message.toArrayBuffer(), session);
      record.updateSessionState(session);
      await this.storage.storeSession(address, record.serialize());
      if (preKeyId !== undefined && preKeyId !== null) {
        await this.storage.removePreKey(preKeyId);
      }
      return plaintext;
    });
  },

  doDecryptWhisperMessage: async function(messageBytes, session) {
    if (!(messageBytes instanceof ArrayBuffer)) {
        throw new Error("Expected messageBytes to be an ArrayBuffer");
    }
    const version = (new Uint8Array(messageBytes))[0];
    if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
        throw new Error("Incompatible version number on WhisperMessage");
    }
    const messageProto = messageBytes.slice(1, messageBytes.byteLength- 8);
    const mac = messageBytes.slice(messageBytes.byteLength - 8, messageBytes.byteLength);
    const message = Internal.protobuf.WhisperMessage.decode(messageProto);
    const remoteEphemeralKey = message.ephemeralKey.toArrayBuffer();
    if (session === undefined) {
        throw new Error("No session found to decrypt message from " + this.remoteAddress.toString());
    }
    if (session.indexInfo.closed != -1) {
        console.warn('decrypting message for closed session');
    }
    await this.maybeStepRatchet(session, remoteEphemeralKey, message.previousCounter);
    const chain = session[util.toString(message.ephemeralKey)];
    if (chain.chainType === Internal.ChainType.SENDING) {
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
    const keys = await Internal.HKDF(util.toArrayBuffer(messageKey), new ArrayBuffer(32), "WhisperMessageKeys");
    const ourIdentityKey = await this.storage.getIdentityKeyPair();
    const macInput = new Uint8Array(messageProto.byteLength + 33*2 + 1);
    macInput.set(new Uint8Array(util.toArrayBuffer(session.indexInfo.remoteIdentityKey)));
    macInput.set(new Uint8Array(util.toArrayBuffer(ourIdentityKey.pubKey)), 33);
    macInput[33*2] = (3 << 4) | 3;
    macInput.set(new Uint8Array(messageProto), 33*2 + 1);
    await Internal.verifyMAC(macInput.buffer, keys[1], mac, 8);
    const plaintext = await Internal.crypto.decrypt(keys[0], message.ciphertext.toArrayBuffer(), keys[2].slice(0, 16));
    delete session.pendingPreKey;
    return plaintext;
  },

  fillMessageKeys: async function(chain, counter) {
    if (chain.chainKey.counter >= counter) {
      return;
    }
    if (chain.chainType !== Internal.ChainType.SENDING) {
      console.error("FILL MSG KEYS", counter, chain.chainKey.counter);
    }
    if (counter - chain.chainKey.counter > 2000) {
        throw new Error('Over 2000 messages into the future!');
    }
    if (chain.chainKey.key === undefined) {
        throw new Error("Got invalid request to extend chain after it was already closed");
    }
    const key = util.toArrayBuffer(chain.chainKey.key);
    const signed = await Promise.all([
      Internal.crypto.sign(key, (new Uint8Array([1])).buffer),
      Internal.crypto.sign(key, (new Uint8Array([2])).buffer)
    ]);
    chain.messageKeys[chain.chainKey.counter + 1] = signed[0];
    chain.chainKey.key = signed[1];
    chain.chainKey.counter += 1;
    return await this.fillMessageKeys(chain, counter);
  },

  maybeStepRatchet: async function(session, remoteKey, previousCounter) {
    if (session[util.toString(remoteKey)] !== undefined) {
      return;
    }
    const ratchet = session.currentRatchet;
    let previousRatchet = session[util.toString(ratchet.lastRemoteEphemeralKey)];
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
    previousRatchet = util.toString(ratchet.ephemeralKeyPair.pubKey);
    if (session[previousRatchet] !== undefined) {
      ratchet.previousCounter = session[previousRatchet].chainKey.counter;
      delete session[previousRatchet];
    }
    const keyPair = await Internal.crypto.createKeyPair();
    ratchet.ephemeralKeyPair = keyPair;
    await this.calculateRatchet(session, remoteKey, true);
    ratchet.lastRemoteEphemeralKey = remoteKey;
  },

  calculateRatchet: async function(session, remoteKey, sending) {
    const ratchet = session.currentRatchet;
    const sharedSecret = await Internal.crypto.ECDHE(remoteKey,
                                                     util.toArrayBuffer(ratchet.ephemeralKeyPair.privKey));
    const masterKey = await Internal.HKDF(sharedSecret, util.toArrayBuffer(ratchet.rootKey),
                                          "WhisperRatchet");
    const ephemeralPublicKey = sending ? ratchet.ephemeralKeyPair.pubKey : remoteKey;
    session[util.toString(ephemeralPublicKey)] = {
        messageKeys: {},
        chainKey: {
          counter: -1,
          key: masterKey[1]
        },
        chainType: sending ? Internal.ChainType.SENDING : Internal.ChainType.RECEIVING
    };
    ratchet.rootKey = masterKey[0];
  },

  getRemoteRegistrationId: async function() {
    const address = this.remoteAddress.toString();
    return await Internal.SessionLock.queueJobForNumber(address, async () => {
      const record = await this.getRecord(address);
      if (record === undefined) {
          return undefined;
      }
      const openSession = record.getOpenSession();
      if (openSession === undefined) {
          return null;
      }
      return openSession.registrationId;
    });
  },

  hasOpenSession: async function() {
    const address = this.remoteAddress.toString();
    return await Internal.SessionLock.queueJobForNumber(address, async () => {
      const record = await this.getRecord(address);
      if (record === undefined) {
          return false;
      }
      return record.haveOpenSession();
    });
  },

  closeOpenSessionForDevice: async function() {
    const address = this.remoteAddress.toString();
    return await Internal.SessionLock.queueJobForNumber(address, async () => {
      const record = await this.getRecord(address);
      if (record === undefined || record.getOpenSession() === undefined) {
        return;
      }
      record.archiveCurrentState();
      await this.storage.storeSession(address, record.serialize());
    });
  },

  deleteAllSessionsForDevice: async function() {
    // Used in session reset scenarios, where we really need to delete
    const address = this.remoteAddress.toString();
    await Internal.SessionLock.queueJobForNumber(address, async () => {
      const record = await this.getRecord(address);
      if (record === undefined) {
          return;
      }
      record.deleteAllSessions();
      await this.storage.storeSession(address, record.serialize());
    });
  }
};


libsignal.SessionCipher = function(storage, remoteAddress) {
    const cipher = new SessionCipher(storage, remoteAddress);
    this.encrypt = cipher.encrypt.bind(cipher);
    this.decryptPreKeyWhisperMessage = cipher.decryptPreKeyWhisperMessage.bind(cipher);
    this.decryptWhisperMessage = cipher.decryptWhisperMessage.bind(cipher);
    this.getRemoteRegistrationId = cipher.getRemoteRegistrationId.bind(cipher);
    this.hasOpenSession = cipher.hasOpenSession.bind(cipher);
    this.closeOpenSessionForDevice = cipher.closeOpenSessionForDevice.bind(cipher);
    this.deleteAllSessionsForDevice = cipher.deleteAllSessionsForDevice.bind(cipher);
};
