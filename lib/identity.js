const crypto = require('crypto')

// A new identity. The public key, as base64url text, is the author id.
function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { publicKey: publicKey.export({ format: 'jwk' }).x, privateKey }
}

// Stamp the author and sign everything else in the op.
function sign(op, keys) {
  const body = { ...op, author: keys.publicKey }
  const sig = crypto.sign(null, Buffer.from(JSON.stringify(body)), keys.privateKey)
  return { ...body, sig: sig.toString('base64url') }
}
// True only if `sig` was made by the private key behind `author`, over this exact op.
// A bad signature returns false; malformed input throws and lands in the catch.
function verify(op) {
  try {
    const { sig, ...body } = op

    const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: op.author }, format: 'jwk' })

    return crypto.verify(null, Buffer.from(JSON.stringify(body)), publicKey, Buffer.from(sig, 'base64url'))
  } catch {
    return false
  }
}

module.exports = { keyPair, sign, verify }
