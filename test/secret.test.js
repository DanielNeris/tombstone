const test = require('node:test')
const assert = require('node:assert')
const { secret, seal, open } = require('../lib/secret')

test('should make a fresh 256-bit key each time', () => {
  const a = secret()
  assert.strictEqual(Buffer.from(a, 'base64url').length, 32)
  assert.notStrictEqual(a, secret())
})

test('should round trip seal and open, unicode included', () => {
  const key = secret()
  for (const text of ['oi', '', 'olá, tudo bem? 👋']) {
    assert.strictEqual(open(seal(text, key), key), text)
  }
})

test('should not show the text in the box, and should seal the same text differently each time', () => {
  const key = secret()
  const a = seal('hello world', key)
  const b = seal('hello world', key)
  assert.ok(!Buffer.from(a.box, 'base64url').toString().includes('hello'))
  assert.notStrictEqual(a.iv, b.iv)
  assert.notStrictEqual(a.box, b.box)
})

test('should return null for the wrong key, a changed box or garbage', () => {
  const key = secret()
  const sealed = seal('oi', key)
  assert.strictEqual(open(sealed, secret()), null)

  const box = Buffer.from(sealed.box, 'base64url')
  box[0] ^= 1
  assert.strictEqual(open({ ...sealed, box: box.toString('base64url') }, key), null)

  assert.strictEqual(open({ iv: 'x', box: 'y' }, key), null)
  assert.strictEqual(open({}, key), null)
})
