// One key per message, so a message can be made unreadable by throwing its key away.
//
// This is crypto-shredding. The log is append-only and replicated everywhere, so
// the ciphertext of a deleted message stays in it forever. What we can delete is
// the key: without it, the ciphertext is noise.
//
// AES-256-GCM. The box is the ciphertext plus a 16-byte auth tag, so a box that was
// changed fails to open instead of opening to garbage. The iv is public and random;
// it must never repeat with the same key, which can't happen here: each key seals
// one message only.

const crypto = require('crypto')

// A fresh 256-bit key for one message.
function secret() {
  return crypto.randomBytes(32).toString('base64url')
}

// Encrypt text with a key. Returns { iv, box }, both base64url, ready for JSON.
function seal(text, key) {
  const iv = crypto.randomBytes(12) // 12 bytes is the size GCM is designed for
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { iv: iv.toString('base64url'), box: body.toString('base64url') }
}

// The text, or null when the key is wrong or the box was changed.
function open({ iv, box }, key) {
  try {
    const body = Buffer.from(box, 'base64url')
    const tag = body.subarray(body.length - 16) // the last 16 bytes are the auth tag
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8')
  } catch {
    return null // final() throws when the tag doesn't match
  }
}

module.exports = { secret, seal, open }
