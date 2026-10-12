const test = require('node:test')
const assert = require('node:assert')
const { View } = require('../lib/view')
const { keyPair, sign } = require('../lib/identity')
const { secret, seal } = require('../lib/secret')

const daniel = keyPair()
const bob = keyPair()
const mod = keyPair()

// Signed ops, the way a peer builds them. Clocks default to seq + 1.
const msg = (keys, seq, clock = seq + 1) => sign({ type: 'msg', ...seal('hi', secret()), seq, clock }, keys)
const del = (keys, target, seq, clock = seq + 1) => sign({ type: 'delete', target, seq, clock }, keys)
const idOf = op => `${op.author}/${op.seq}`

// What a view shows, as comparable text: who wrote it and whether it's deleted.
const names = { [daniel.publicKey]: 'daniel', [bob.publicKey]: 'bob', [mod.publicKey]: 'mod' }
const show = view => view.messages().map(m => `${names[m.author]}${m.deleted ? ' (deleted)' : ''}`)

test('should give a message the id author/seq and start it alive', () => {
  const view = new View()
  const op = msg(daniel, 0)
  view.apply(op)
  const [m] = view.messages()
  assert.strictEqual(m.id, idOf(op))
  assert.strictEqual(m.author, daniel.publicKey)
  assert.strictEqual(m.clock, 1)
  assert.strictEqual(m.box, op.box)
  assert.strictEqual(m.deleted, false)
})

test('should return copies from messages(), so the view cannot be changed from outside', () => {
  const view = new View({})
  view.apply(msg(daniel, 0))
  view.messages()[0].deleted = true
  assert.strictEqual(view.messages()[0].deleted, false)
})

test('should let the author delete and should not let anyone else', () => {
  const view = new View()
  const a = msg(daniel, 0)
  const b = msg(bob, 0)
  view.apply(a)
  view.apply(b)
  view.apply(del(bob, idOf(a), 1)) // not his: ignored
  view.apply(del(bob, idOf(b), 2)) // his: ok
  assert.deepStrictEqual(show(view).sort(), ['bob (deleted)', 'daniel']) // same clock: order depends on the keys
})

test('should let an admin delete anyone', () => {
  const view = new View({ admins: [mod.publicKey] })
  const a = msg(daniel, 0)
  view.apply(a)
  view.apply(del(mod, idOf(a), 0))
  assert.deepStrictEqual(show(view), ['daniel (deleted)'])
})

test('should keep a delete that arrives early until its message comes', () => {
  const view = new View()
  const a = msg(daniel, 0)
  const b = msg(daniel, 1)
  view.apply(del(daniel, idOf(a), 2))
  view.apply(del(bob, idOf(a), 0)) // also waits, and is still refused when the message comes
  assert.deepStrictEqual(show(view), [])
  view.apply(a)
  view.apply(b) // nothing pending for this one
  assert.deepStrictEqual(show(view), ['daniel (deleted)', 'daniel'])
})

test('should not bring a deleted message back on a duplicate', () => {
  const view = new View()
  const a = msg(daniel, 0)
  view.apply(a)
  view.apply(del(daniel, idOf(a), 1))
  view.apply(a)
  assert.deepStrictEqual(show(view), ['daniel (deleted)'])
})

test('should ignore ops with a bad signature and unknown op types', () => {
  const view = new View()
  const a = msg(daniel, 0)
  view.apply({ ...a, author: bob.publicKey }) // forged author
  view.apply(sign({ type: 'edit', seq: 0, clock: 1 }, daniel))
  assert.deepStrictEqual(view.messages(), [])
})

test("should not let anyone take over the id of someone else's message", () => {
  // bob copies daniel's seq, so a view keyed only by a chosen id would mix them up
  const real = msg(daniel, 0)
  const fake = sign({ type: 'msg', id: idOf(real), ...seal('fake', secret()), seq: 0, clock: 1 }, bob)
  const attack = del(bob, idOf(real), 1)
  for (const order of [
    [real, fake, attack],
    [fake, real, attack],
  ]) {
    const view = new View()
    for (const op of order) view.apply(op)
    assert.deepStrictEqual(show(view).sort(), ['bob', 'daniel'])
  }
})

test('should order by clock, then author key, whatever the arrival order', () => {
  const a = msg(daniel, 0, 1)
  const b = msg(bob, 0, 1) // same clock as a: the author key decides
  const c = msg(daniel, 1, 2)
  const [first, second] = daniel.publicKey < bob.publicKey ? ['daniel', 'bob'] : ['bob', 'daniel']
  for (const order of [
    [a, b, c],
    [c, b, a],
    [b, a, c],
  ]) {
    const view = new View()
    for (const op of order) view.apply(op)
    assert.deepStrictEqual(show(view), [first, second, 'daniel'])
  }
})

test('should give the same view for every arrival order of the same ops', () => {
  const a = msg(daniel, 0)
  const b = msg(bob, 0)
  const ops = [a, a, b, del(daniel, idOf(a), 1), msg(daniel, 2)] // a twice: duplicates happen

  function permutations(list) {
    if (list.length <= 1) return [list]
    return list.flatMap((op, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(p => [op, ...p]))
  }

  const results = new Set()
  for (const order of permutations(ops)) {
    const view = new View()
    for (const op of order) view.apply(op)
    results.add(JSON.stringify(show(view)))
  }
  assert.strictEqual(results.size, 1) // 120 orders, one result
})
