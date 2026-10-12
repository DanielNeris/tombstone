const test = require('node:test')
const assert = require('node:assert')
const { Log } = require('../lib/log')

test('should return the seq of each op, starting at 0', () => {
  const log = new Log()
  assert.strictEqual(log.append({ n: 'a' }), 0)
  assert.strictEqual(log.append({ n: 'b' }), 1)
  assert.strictEqual(log.append({ n: 'c' }), 2)
  assert.strictEqual(log.length, 3)
  assert.deepStrictEqual(log.get(1), { n: 'b' })
  assert.strictEqual(log.get(3), undefined)
})

test('should freeze ops once appended', () => {
  const log = new Log()
  const op = { text: 'oi' }
  log.append(op)
  assert.ok(Object.isFrozen(op))
  assert.throws(() => {
    'use strict'
    log.get(0).text = 'changed'
  }, TypeError)
  assert.strictEqual(log.get(0).text, 'oi')
})

test('should iterate in append order', () => {
  const log = new Log()
  for (const n of [1, 2, 3]) log.append({ n })
  assert.deepStrictEqual(
    [...log].map(op => op.n),
    [1, 2, 3],
  )
})
