// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    self.libsignal = self.libsignal || {};
    const ns = self.libsignal.util = {};
    
    var StaticArrayBufferProto = new ArrayBuffer().__proto__;

    ns.toString = function(thing) {
        console.warn("DEPRECATED toString.  Use bytesToString() instead");
        if (typeof thing == 'string') {
            return thing;
        }
        return new dcodeIO.ByteBuffer.wrap(thing).toString('binary');
    };

    ns.toArrayBuffer = function(thing) {
        console.warn("DEPRECATED toArrayBuffer.  Use stringToBytes() instead");
        debugger;
        if (thing === undefined) {
            return undefined;
        }
        if (thing === Object(thing)) {
            if (thing.__proto__ == StaticArrayBufferProto) {
                return thing;
            }
        }

        if (typeof thing !== "string") {
            throw new Error("Tried to convert a non-string of type " + typeof thing + " to an array buffer");
        }
        return new dcodeIO.ByteBuffer.wrap(thing, 'binary').toArrayBuffer();
    };

    ns.stringToBytes = function(data) {
        // Note this expects the string encoding to be 8 bits per char point, not 16.
        if (typeof data !== 'string') {
            throw new TypeError("string argument required");
        }
        // Optimized for V8...
        const bytes = new Array(data.length);
        for (let i = 0, len = data.length; i < len; i++) {
            bytes[i] = data.charCodeAt(i);
        }
        return new Uint8Array(bytes);
    };

    ns.stringToArrayBuffer = function(data) {
        return ns.stringToBytes(data).buffer;
    };

    ns.bytesToString = function(data) {
        // Note this translates the data into 8 bits per char point, not 16.
        if (!(data instanceof Uint8Array)) {
            throw new TypeError("Uint8Array argument required");
        }
        return String.fromCharCode.apply(null, data);
    };

    ns.arrayBufferToString = function(data) {
        if (!(data instanceof ArrayBuffer)) {
            throw new TypeError("ArrayBuffer argument required");
        }
        return ns.bytesToString(new Uint8Array(data));
    };

    ns.bytesToHex = function(data) {
        if (!(data instanceof Uint8Array)) {
            throw new TypeError("data must be Uint8Array");
        }
        const bytes = new Uint8Array(data);
        const digits = new Array(bytes.length);
        for (const x of bytes) {
            digits.push(x.toString(16).padStart(2, '0'));
        }
        return digits.join('');
    };

    ns.arrayBufferToHex = function(data) {
        if (!(data instanceof ArrayBuffer)) {
            throw new TypeError("data must be ArrayBuffer");
        }
        return ns.bytesToHex(new Uint8Array(data));
    };

    ns.stringToHex = function(data) {
        if (typeof data !== 'string') {
            throw new TypeError("data must be String");
        }
        return ns.bytesToHex(libsignal.util.stringToBytes(data));
    };

    ns.hexToBytes = function(data) {
        if (typeof data !== 'string') {
            throw new TypeError("data must be string");
        }
        if (data.length < 2 || data.length % 2) {
            throw new TypeError("Invalid hex string (wrong padding)");
        }
        const uints = [];
        for (let i = 0; i < data.length; i += 2) {
            uints.push(parseInt(data.slice(i, i + 2), 16));
        }
        return new Uint8Array(uints);
    };

    ns.hexToArrayBuffer = function(data) {
        return ns.hexToBytes(data).buffer;
    };

    ns.isEqual = function(a, b) {
        // TODO: Special-case arraybuffers, etc
        if (a === undefined || b === undefined) {
            return false;
        }
        a = ns.toString(a);
        b = ns.toString(b);
        var maxLength = Math.max(a.length, b.length);
        if (maxLength < 5) {
            throw new Error("a/b compare too short");
        }
        return a.substring(0, Math.min(maxLength, a.length)) == b.substring(0, Math.min(maxLength, b.length));
    };
})();
