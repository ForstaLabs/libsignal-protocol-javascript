// vim: ts=4:sw=4

(function() {
    'use strict';

    const ns = self.libsignal = self.libsignal || {};

    ns.BaseKeyType = {
        OURS: 1,
        THEIRS: 2
    };

    ns.ChainType = {
        SENDING: 1,
        RECEIVING: 2
    };

    const CLOSED_SESSIONS_MAX = 40;
    const SESSION_RECORD_VERSION = 'v2';

    const migrations = [{
        version: 'v1',
        migrate: function(data) {
            const sessions = data.sessions;
            if (data.registrationId) {
                for (const key in sessions) {
                    if (!sessions[key].registrationId) {
                        sessions[key].registrationId = data.registrationId;
                    }
                }
            } else {
                for (const key in sessions) {
                    if (sessions[key].indexInfo.closed === -1) {
                        console.error('V1 session storage migration error: registrationId',
                            data.registrationId, 'for open session version',
                            data.version);
                    }
                }
            }
        }
    }, {
        version: 'v2',
        migrate: function(data) {
            const s2ab = ns.util.stringToArrayBuffer;
            const sessions = new Map();  // Note: Map not ArrayBufferMap to emulate storage.
            for (const key of Object.keys(data.sessions)) {
                const sessionKey = s2ab(key);
                if (sessionKey.byteLength != 33) {
                    console.error("Unexpected session key!", key);
                    debugger;
                    continue;
                }
                const v1 = data.sessions[key];
                const v2 = {};

                v2.currentRatchet = {
                    ephemeralKeyPair: {
                        privKey: s2ab(v1.currentRatchet.ephemeralKeyPair.privKey),
                        pubKey: s2ab(v1.currentRatchet.ephemeralKeyPair.pubKey),
                    },
                    lastRemoteEphemeralKey: s2ab(v1.currentRatchet.lastRemoteEphemeralKey),
                    previousCounter: v1.currentRatchet.previousCounter,
                    rootKey: s2ab(v1.currentRatchet.rootKey)
                };
                delete v1.currentRatchet;

                v2.indexInfo = {
                    baseKey: s2ab(v1.indexInfo.baseKey),
                    baseKeyType: v1.indexInfo.baseKeyType,
                    closed: v1.indexInfo.closed,
                    remoteIdentityKey: s2ab(v1.indexInfo.remoteIdentityKey)
                };
                delete v1.indexInfo;

                delete v1.oldRatchetList;  // never used.

                if (v1.pendingPreKey) {
                    v2.pendingPreKey = {
                        baseKey: s2ab(v1.pendingPreKey.baseKey),
                        preKeyId: v1.pendingPreKey.preKeyId,
                        signedKeyId: v1.pendingPreKey.signedKeyId,
                    };
                }
                delete v1.pendingPreKey;

                v2.registrationId = v1.registrationId;
                delete v1.registrationId;

                // All remaining keys on the v1 should be chains...
                v2.chains = new Map();  // Note: Map not ArrayBufferMap to emulate storage.
                for (const x of Object.keys(v1)) {
                    const chainKey = ns.util.stringToArrayBuffer(x);
                    if (chainKey.byteLength != 33) {
                        console.error("Unexpected chain key!", x);
                        debugger;
                        continue;
                    }
                    const v1Chain = v1[x];
                    v2.chains.set(ns.util.arrayBufferToHex(chainKey), {
                        chainKey: {
                            counter: v1Chain.chainKey.counter,
                            key: v1Chain.chainKey.key && s2ab(v1Chain.chainKey.key),
                        },
                        chainType: v1Chain.chainType,
                        messageKeys: new Map(Array.from(Object.entries(v1Chain.messageKeys)).map(x =>
                            [x[0], s2ab(x[1])]))
                    });
                }

                sessions.set(ns.util.arrayBufferToHex(sessionKey), v2);
            }
            data.sessions = sessions;
        }
    }];

    function migrate(data) {
        let head = 0;
        if (data.version) {
            head = migrations.findIndex(x => x.version === data.version) + 1;
            if (!head) {
                console.error("Migrating from unknown session version:", data.version);
            }
        }
        for (const x of migrations.slice(head)) {
            console.warn(`Migrating session: ${data.version} -> ${x.version}`);
            x.migrate(data);
        }
    }


    ns.ArrayBufferMap = class ArrayBufferMap extends Map {

        static fromStorage(data) {
            if (data instanceof this) {
                return data;
            }
            if (data.constructor !== Map) {
                throw new TypeError("Map required");
            }
            const instance = new this();
            for (const x of data.entries()) {
                Map.prototype.set.call(instance, x[0], x[1]);
            }
            return instance;
        }

        encodeKey(key) {
            if (!(key instanceof ArrayBuffer)) {
                throw new TypeError("ArrayBuffer required");
            }
            return ns.util.arrayBufferToHex(key);
        }

        decodeKey(encoded) {
            if (typeof encoded !== 'string') {
                throw new TypeError("string required");
            }
            return ns.util.hexToArrayBuffer(encoded);
        }

        has(key) {
            return super.has(this.encodeKey(key));
        }

        get(key) {
            return super.get(this.encodeKey(key));
        }

        set(key, value) {
            return super.set(this.encodeKey(key), value);
        }

        delete(key) {
            return super.delete(this.encodeKey(key));
        }

        *keys() {
            for (const k of super.keys()) {
                yield this.decodeKey(k);
            }
        }

        *entries() {
            for (const x of super.entries()) {
                yield [this.decodeKey(x[0]), x[1]];
            }
        }
    };


    ns.SessionRecord = class SessionRecord {

        constructor(sessions) {
            if (sessions) {
                if (!(sessions instanceof ns.ArrayBufferMap)) {
                    throw new TypeError("ArrayBufferMap required");
                }
            } else {
                sessions = new ns.ArrayBufferMap();
            }
            this.sessions = sessions;
            this.version = SESSION_RECORD_VERSION;
        }

        static fromStorage(data) {
            // Parse structured data from storage engine into typed values.
            if (!data) {
                return new this();
            }
            if (data instanceof this) {
                return data;
            }
            if (typeof data === 'string') {
                console.warn("Loading legacy session");
                data = JSON.parse(data);
            }
            if (data.version !== SESSION_RECORD_VERSION) {
                migrate(data);
            }
            for (const session of data.sessions.values()) {
                session.chains = ns.ArrayBufferMap.fromStorage(session.chains);
            }
            return new this(ns.ArrayBufferMap.fromStorage(data.sessions));
        }

        haveOpenSession() {
            var openSession = this.getOpenSession();
            return (!!openSession && typeof openSession.registrationId === 'number');
        }

        getSession(key) {
            const session = this.sessions.get(key);
            if (session && session.indexInfo.baseKeyType === ns.BaseKeyType.OURS) {
                throw new Error("Tried to lookup a session using our basekey");
            }
            return session;
        }

        getOpenSession() {
            for (const session of this.sessions.values()) {
                if (!this.isClosed(session)) {
                    return session;
                }
            }
        }

        setSession(session) {
            this.sessions.set(session.indexInfo.baseKey, session);
        }

        getSessions() {
            // Return sessions ordered with most recently used first.
            return Array.from(this.sessions.values()).sort((a, b) => {
                const aUsed = a.indexInfo.used || 0;
                const bUsed = b.indexInfo.used || 0;
                return aUsed === bUsed ? 0 : aUsed < bUsed ? 1 : -1;
            });
        }

        closeSession(session) {
            if (this.isClosed(session)) {
                console.warn("Session already closed", session);
                return;
            }
            console.info("Closing session:", session);
            session.indexInfo.closed = Date.now();
        }

        openSession(session) {
            if (!this.isClosed(session)) {
                console.warn("Session already open");
            }
            console.info("Opening session:", session);
            session.indexInfo.closed = -1;
        }

        isClosed(session) {
            return session.indexInfo.closed !== -1;
        }

        removeOldSessions() {
            while (this.sessions.size > CLOSED_SESSIONS_MAX) {
                let oldestKey;
                let oldestSession;
                for (const x of this.sessions.entries()) {
                    const key = x[0];
                    const session = x[1];
                    if (session.indexInfo.closed !== -1 &&
                        (!oldestSession || session.indexInfo.closed < oldestSession.indexInfo.closed)) {
                        oldestKey = key;
                        oldestSession = session;
                    }
                }
                if (oldestKey) {
                    console.info("Removing old closed session:", oldestSession);
                    this.sessions.delete(oldestKey);
                } else {
                    throw new Error('Corrupt session map');
                }
            }
        }

        deleteAllSessions() {
            this.sessions.clear();
        }
    };
})();
