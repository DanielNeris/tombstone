// Who wrote an op: Ed25519 keys and signatures.
//
// The author of an op is a public key, not a name, and every op is signed with
// the matching private key. Anyone can check a signature and nobody can fake one,
// so a peer can't write in someone else's name or change an op after it was sent.
//
// We sign JSON.stringify(op). That works because we build every op ourselves and
// the key order stays the same. Real systems sign a fixed binary encoding instead
// (Holepunch uses compact-encoding).

const crypto = require('crypto')

// A new identity. The public key, as base64url text, is the author id.
function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { publicKey: publicKey.export({ format: 'jwk' }).x, privateKey } // jwk.x is the raw 32-byte key
}

// Stamp the author and sign everything else in the op.
// The author is set here, from the key: whoever signs can't pick who they are.
function sign(op, keys) {
  const body = { ...op, author: keys.publicKey }
  const sig = crypto.sign(null, Buffer.from(JSON.stringify(body)), keys.privateKey)
  return { ...body, sig: sig.toString('base64url') }
}

// True only if `sig` was made by the private key behind `author`, over this exact op.
// Two ways to be invalid: a signature that doesn't match returns false,
// and malformed input (no sig, an author that isn't a key) throws and lands in the catch.
function verify(op) {
  try {
    const { sig, ...body } = op // the signed bytes are the op without its sig
    const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: op.author }, format: 'jwk' })
    return crypto.verify(null, Buffer.from(JSON.stringify(body)), publicKey, Buffer.from(sig, 'base64url'))
  } catch {
    return false // data from the network must never crash the peer
  }
}

module.exports = { keyPair, sign, verify }
