default: dist/libsignal-protocol.min.js

dist/libsignal-protocol.min.js: dist/libsignal-protocol.js
	node_modules/.bin/uglifyjs dist/libsignal-protocol.js -o $@

dist/libsignal-protocol.js: $(shell find src -type f) Makefile
	node_modules/.bin/grunt

compile:
	node_modules/.bin/grunt compile
