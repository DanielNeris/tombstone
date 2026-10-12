const test = require('node:test')
const assert = require('node:assert')
const { Log } = require('../lib/log')

test('should keep ops by seq and count them from 0', () => {
  const log = new Log()
  assert.strictEqual(log.length, 0)
  assert.strictEqual(log.put(0, { n: 'a' }), true)
  assert.strictEqual(log.put(1, { n: 'b' }), true)
  assert.strictEqual(log.length, 2)
  assert.deepStrictEqual(log.get(1), { n: 'b' })
  assert.strictEqual(log.has(1), true)
  assert.strictEqual(log.has(2), false)
  assert.strictEqual(log.get(2), undefined)
})

test('should count only the run with no gap, and close the gap when the missing op arrives', () => {
  const log = new Log()
  for (const seq of [0, 1, 2, 4]) log.put(seq, { seq })
  assert.strictEqual(log.length, 3) // 3 is missing
  assert.strictEqual(log.has(4), true) // 4 is kept, just not counted yet
  log.put(3, { seq: 3 })
  assert.strictEqual(log.length, 5) // 3 closed the gap, and 4 counts now
})

test('should not replace an op: the first one for a seq stays', () => {
  const log = new Log()
  const first = { text: 'oi' }
  log.put(0, first)
  assert.strictEqual(log.put(0, { text: 'changed' }), false)
  assert.strictEqual(log.get(0), first)
  assert.strictEqual(log.length, 1)
})

test('should freeze ops once they are in the log', () => {
  const log = new Log()
  const op = { text: 'oi' }
  log.put(0, op)
  assert.ok(Object.isFrozen(op))
  assert.throws(() => {
    'use strict'
    log.get(0).text = 'changed'
  }, TypeError)
  assert.strictEqual(log.get(0).text, 'oi')
})
