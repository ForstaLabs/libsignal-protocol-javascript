
var store = {keyId: 69696969};
var KeyHelper = libsignal.KeyHelper;
console.log('KeyHelper', KeyHelper)

store.registrationId = KeyHelper.generateRegistrationId();
console.log('registrationId', store.registrationId)
// Store registrationId somewhere durable and safe.

KeyHelper.generateIdentityKeyPair().then(function(identityKeyPair) {
    console.log('identityKeyPair', identityKeyPair)
    store.identityKeyPair = identityKeyPair
    // keyPair -> { pubKey: ArrayBuffer, privKey: ArrayBuffer }
    // Store identityKeyPair somewhere durable and safe.
    return new Promise((resolve, reject) => resolve(identityKeyPair))
}).then((identityKeyPair) => {
  console.log('generatePreKey', store.keyId)
  return KeyHelper.generatePreKey(store.keyId).then(function(preKey) {
    console.log('preKey', preKey)
      // store.storePreKey(preKey.keyId, preKey.keyPair);
      store.preKey = preKey;
    return preKey
  }).then((preKey) => {
    return new Promise((resolve, reject) => resolve({preKey, identityKeyPair}))
  })
}).then(({identityKeyPair, preKey}) => {
  return KeyHelper.generateSignedPreKey(identityKeyPair, store.keyId).then(function(signedPreKey) {
    console.log('signedPreKey', signedPreKey)
    // store.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);
    store.storeSignedPreKey = signedPreKey;
    return signedPreKey
  });
}).then((signedPreKey) => {
  console.log('DONE!?', store)
})
