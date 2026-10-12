const test = require('node:test')
const assert = require('node:assert')
const { keyPair, sign, verify } = require('../lib/identity')

const daniel = keyPair()
const bob = keyPair()

test('should create a 32-byte public key as base64url text', () => {
  assert.strictEqual(Buffer.from(daniel.publicKey, 'base64url').length, 32)
  assert.notStrictEqual(daniel.publicKey, bob.publicKey)
})

test('should stamp the author and a signature that verifies', () => {
  const op = sign({ type: 'msg', text: 'oi' }, daniel)
  assert.strictEqual(op.author, daniel.publicKey)
  assert.strictEqual(typeof op.sig, 'string')
  assert.ok(verify(op))
})

test('should not let the signer choose the author', () => {
  const op = sign({ type: 'msg', author: daniel.publicKey }, bob)
  assert.strictEqual(op.author, bob.publicKey)
})

test('should not verify an op changed after signing', () => {
  const op = sign({ type: 'msg', text: 'oi', seq: 0 }, daniel)
  assert.strictEqual(verify({ ...op, text: 'changed' }), false)
  assert.strictEqual(verify({ ...op, seq: 1 }), false)
  assert.strictEqual(verify({ ...op, author: bob.publicKey }), false) // forged author
})

test('should not throw on garbage, just return false', () => {
  for (const op of [null, undefined, 42, {}, { author: 'not a key', sig: 'x' }, { author: daniel.publicKey }]) {
    assert.strictEqual(verify(op), false)
  }
})
