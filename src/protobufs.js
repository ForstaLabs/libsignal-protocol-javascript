// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    self.libsignal = self.libsignal || {};
    const ns = self.libsignal.protobuf = {};

    function loadProtoBufs(filename) {
        return dcodeIO.ProtoBuf.loadProto(libsignal.protoText['protos/' + filename]).build('textsecure');
    }

    const protocolMessages = loadProtoBufs('WhisperTextProtocol.proto');
    ns.WhisperMessage = protocolMessages.WhisperMessage;
    ns.PreKeyWhisperMessage = protocolMessages.PreKeyWhisperMessage;
})();
