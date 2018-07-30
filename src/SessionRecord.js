/*
 * vim: ts=4:sw=4
 */

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

    var ARCHIVED_STATES_MAX_LENGTH = 40;
    var OLD_RATCHETS_MAX_LENGTH = 10;
    var SESSION_RECORD_VERSION = 'v1';

    var StaticByteBufferProto = new dcodeIO.ByteBuffer().__proto__;
    var StaticArrayBufferProto = new ArrayBuffer().__proto__;
    var StaticUint8ArrayProto = new Uint8Array().__proto__;

    function isStringable(thing) {
        return (thing === Object(thing) &&
                (thing.__proto__ == StaticArrayBufferProto ||
                 thing.__proto__ == StaticUint8ArrayProto ||
                 thing.__proto__ == StaticByteBufferProto));
    }

    function ensureStringed(thing) {
        if (typeof thing == "string" || typeof thing == "number" || typeof thing == "boolean") {
            return thing;
        } else if (isStringable(thing)) {
            return ns.util.toString(thing);
        } else if (thing instanceof Array) {
            var array = [];
            for (var i = 0; i < thing.length; i++) {
                array[i] = ensureStringed(thing[i]);
            }
            return array;
        } else if (thing === Object(thing)) {
            var obj = {};
            for (var key in thing) {
                obj[key] = ensureStringed(thing[key]);
            }
            return obj;
        } else if (thing === null) {
            return null;
        } else {
            throw new Error("unsure of how to jsonify object of type " + typeof thing);
        }
    }

    function jsonThing(thing) {
        return JSON.stringify(ensureStringed(thing)); //TODO: jquery???
    }

    var migrations = [{
        version: 'v1',
        migrate: function migrateV1(data) {
            var sessions = data.sessions;
            var key;
            if (data.registrationId) {
                for (key in sessions) {
                    if (!sessions[key].registrationId) {
                        sessions[key].registrationId = data.registrationId;
                    }
                }
            } else {
                for (key in sessions) {
                    if (sessions[key].indexInfo.closed === -1) {
                        console.error('V1 session storage migration error: registrationId',
                            data.registrationId, 'for open session version',
                            data.version);
                    }
                }
            }
        }
    }];

    function migrate(data) {
        var run = (data.version === undefined);
        for (var i=0; i < migrations.length; ++i) {
            if (run) {
                migrations[i].migrate(data);
            } else if (migrations[i].version === data.version) {
                run = true;
            }
        }
        if (!run) {
            throw new Error("Error migrating SessionRecord");
        }
    }


    ns.SessionRecord = class SessionRecord {

        constructor() {
            this.sessions = {};
            this.version = SESSION_RECORD_VERSION;
        }

        static deserialize(serialized) {
            const data = JSON.parse(serialized);
            if (data.version !== SESSION_RECORD_VERSION) {
                migrate(data);
            }
            const record = new this();
            record.sessions = data.sessions;
            if (record.sessions === undefined || record.sessions === null ||
                typeof record.sessions !== "object" || Array.isArray(record.sessions)) {
                throw new Error("Error deserializing SessionRecord");
            }
            return record;
        }

        serialize() {
            return jsonThing({
                sessions: this.sessions,
                version: this.version
            });
        }

        haveOpenSession() {
            var openSession = this.getOpenSession();
            return (!!openSession && typeof openSession.registrationId === 'number');
        }

        getSessionByBaseKey(baseKey) {
            const session = this.sessions[ns.util.toString(baseKey)];
            if (session && session.indexInfo.baseKeyType === ns.BaseKeyType.OURS) {
                console.warn("Tried to lookup a session using our basekey");
                return undefined;
            }
            return session;
        }

        getSessionByRemoteEphemeralKey(remoteEphemeralKey) {
            this.detectDuplicateOpenSessions();
            var searchKey = ns.util.toString(remoteEphemeralKey);
            var openSession;
            for (var key in this.sessions) {
                if (this.sessions[key].indexInfo.closed == -1) {
                    openSession = this.sessions[key];
                }
                if (this.sessions[key][searchKey] !== undefined) {
                    return this.sessions[key];
                }
            }
            if (openSession !== undefined) {
                return openSession;
            }
            return undefined;
        }

        getOpenSession() {
            if (this.sessions === undefined) {
                return undefined;
            }
            this.detectDuplicateOpenSessions();
            for (const key in this.sessions) {
                if (this.sessions[key].indexInfo.closed == -1) {
                    return this.sessions[key];
                }
            }
            return undefined;
        }

        detectDuplicateOpenSessions() {
            let openSession;
            for (const key in this.sessions) {
                if (this.sessions[key].indexInfo.closed == -1) {
                    if (openSession !== undefined) {
                        throw new Error("Datastore inconsistensy: multiple open sessions");
                    }
                    openSession = this.sessions[key];
                }
            }
        }

        updateSessionState(session) {
            this.removeOldChains(session);
            this.sessions[ns.util.toString(session.indexInfo.baseKey)] = session;
            this.removeOldSessions();
        }

        getSessions() {
            // return an array of sessions ordered by time closed,
            // followed by the open session
            const list = [];
            let openSession;
            for (var k in this.sessions) {
                if (this.sessions[k].indexInfo.closed === -1) {
                    openSession = this.sessions[k];
                } else {
                    list.push(this.sessions[k]);
                }
            }
            list.sort((s1, s2) => s1.indexInfo.closed - s2.indexInfo.closed);
            if (openSession) {
                list.push(openSession);
            }
            return list;
        }

        archiveCurrentState() {
            const openSession = this.getOpenSession();
            if (openSession !== undefined) {
                openSession.indexInfo.closed = Date.now();
                this.updateSessionState(openSession);
            }
        }

        promoteState(session) {
            session.indexInfo.closed = -1;
        }

        removeOldChains(session) {
            // Sending ratchets are always removed when we step because we never need them again
            // Receiving ratchets are added to the oldRatchetList, which we parse
            // here and remove all but the last ten.
            while (session.oldRatchetList.length > OLD_RATCHETS_MAX_LENGTH) {
                let index = 0;
                let oldest = session.oldRatchetList[0];
                for (let i = 0; i < session.oldRatchetList.length; i++) {
                    if (session.oldRatchetList[i].added < oldest.added) {
                        oldest = session.oldRatchetList[i];
                        index = i;
                    }
                }
                delete session[ns.util.toString(oldest.ephemeralKey)];
                session.oldRatchetList.splice(index, 1);
            }
        }

        removeOldSessions() {
            let oldestBaseKey;
            let oldestSession;
            while (Object.keys(this.sessions).length > ARCHIVED_STATES_MAX_LENGTH) {
                for (const key in this.sessions) {
                    const session = this.sessions[key];
                    if (session.indexInfo.closed > -1 && // session is closed
                        (!oldestSession || session.indexInfo.closed < oldestSession.indexInfo.closed)) {
                        oldestBaseKey = key;
                        oldestSession = session;
                    }
                }
                delete this.sessions[ns.util.toString(oldestBaseKey)];
            }
        }

        deleteAllSessions() {
            // Used primarily in session reset scenarios, where we really delete sessions
            this.sessions = {};
        }
    };
})();
