default: dist/libsignal-protocol.min.js

dist/libsignal-protocol.min.js: dist/libsignal-protocol.js
	node_modules/.bin/uglifyjs dist/libsignal-protocol.js -o $@

dist/libsignal-protocol.js: $(shell find src -type f)
	node_modules/.bin/grunt
