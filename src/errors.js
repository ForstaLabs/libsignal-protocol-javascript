// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    const ns = self.libsignal = self.libsignal || {};

    ns.SignalError = class SignalError extends Error {};

    ns.UntrustedIdentityKeyError = class UntrustedIdentityKeyError extends ns.SignalError {
        constructor(props) {
            super();
            this.name = 'IdentityKeyError';
            Object.assign(this, props);
        }
    };

    ns.SessionError = class SessionError extends ns.SignalError {
        constructor(message) {
            super(message);
            this.name = 'SessionError';
        }
    };

    ns.PreKeyError = class PreKeyError extends ns.SignalError {
        constructor(message) {
            super(message);
            this.name = 'PreKeyError';
        }
    };
})();
