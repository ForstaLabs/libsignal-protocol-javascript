/*
 * vim: ts=4:sw=4
 */

(function() {
    'use strict';

    self.libsignal = self.libsignal || {};
    const ns = self.libsignal.util = {};
    
    var StaticArrayBufferProto = new ArrayBuffer().__proto__;

    ns.toString = function(thing) {
        if (typeof thing == 'string') {
            return thing;
        }
        return new dcodeIO.ByteBuffer.wrap(thing).toString('binary');
    };

    ns.toArrayBuffer = function(thing) {
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
