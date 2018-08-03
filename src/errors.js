// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    const ns = self.libsignal = self.libsignal || {};

    ns.SignalError = class SignalError extends Error {};

    ns.UntrustedIdentityKeyError = class UntrustedIdentityKeyError extends ns.SignalError {
        constructor(addr, identityKey) {
            super();
            this.name = 'UntrustedIdentityKeyError';
            this.addr = addr;
            this.identityKey = identityKey;
        }
    };

    ns.SessionError = class SessionError extends ns.SignalError {
        constructor(message) {
            super(message);
            this.name = 'SessionError';
        }
    };

    ns.MessageCounterError = class MessageCounterError extends ns.SessionError {
        constructor(message) {
            super(message);
            this.name = 'MessageCounterError';
        }
    };

    ns.PreKeyError = class PreKeyError extends ns.SessionError {
        constructor(message) {
            super(message);
            this.name = 'PreKeyError';
        }
    };
})();
