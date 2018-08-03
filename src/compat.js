// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    if (self.crypto && !self.crypto.subtle && self.crypto.webkitSubtle) {
        self.crypto.subtle = self.crypto.webkitSubtle;
    }
})();
