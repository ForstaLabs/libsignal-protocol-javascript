if (self.crypto && !self.crypto.subtle && self.crypto.webkitSubtle) {
    self.crypto.subtle = self.crypto.webkitSubtle;
}
