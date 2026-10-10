const crypto = require('crypto')

// A fresh 256-bit key for one message.
function secret() {
  return crypto.randomBytes(32).toString('base64url')
}

// AES-256-GCM. The auth tag goes at the end of the box, so a changed box fails to open.
function seal(text, key) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { iv: iv.toString('base64url'), box: body.toString('base64url') }
}

// The text, or null when the key is wrong or the box was changed.
function open({ iv, box }, key) {
  try {
    const body = Buffer.from(box, 'base64url')
    const tag = body.subarray(body.length - 16)
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

module.exports = { secret, seal, open }
