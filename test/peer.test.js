const test = require('node:test')
const assert = require('node:assert')
const dgram = require('dgram')
const { Peer } = require('../lib/peer')
const { keyPair, sign } = require('../lib/identity')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// Two peers on localhost that know each other.
async function pair(opts) {
  const daniel = new Peer(opts)
  const bob = new Peer(opts)
  daniel.connect(await bob.listen())
  bob.connect(await daniel.listen())
  return { daniel, bob }
}

// Poll until check() is true. With `sync`, both peers exchange `have` every round.
async function until(check, { sync = [], rounds = 150 } = {}) {
  for (let i = 0; i < rounds; i++) {
    if (check()) return
    for (const peer of sync) peer.sync()
    await wait(20)
  }
  throw new Error('timed out')
}

// What a peer's screen shows.
const screen = peer => peer.read().map(m => (m.deleted ? '(deleted)' : (m.text ?? '(no key)')))

// A plain UDP socket, to talk to a peer as a stranger.
async function stranger() {
  const socket = dgram.createSocket('udp4')
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  const received = []
  socket.on('message', buf => received.push(buf.toString()))
  return { socket, received, send: (data, port) => socket.send(data, port, '127.0.0.1') }
}

test('should let the author read a post at once, numbered by seq and clock', async () => {
  const peer = new Peer()
  await peer.listen()
  const a = peer.post('oi')
  const b = peer.post('tudo bem?')
  assert.strictEqual(a, `${peer.keys.publicKey}/0`)
  assert.strictEqual(b, `${peer.keys.publicKey}/1`)
  assert.deepStrictEqual(screen(peer), ['oi', 'tudo bem?'])
  assert.deepStrictEqual(
    peer.read().map(m => m.clock),
    [1, 2],
  )
  peer.close()
})

test('should deliver posts and keys without sync on a clean network', async () => {
  const { daniel, bob } = await pair()
  daniel.post('oi')
  bob.post('hey')
  await until(() => screen(daniel).length === 2 && screen(bob).length === 2)
  assert.deepStrictEqual(screen(daniel).sort(), ['hey', 'oi'])
  assert.deepStrictEqual(screen(daniel), screen(bob)) // same order on both
  daniel.close()
  bob.close()
})

test('should hide a deleted message, shred its key everywhere and keep only noise in the logs', async () => {
  const { daniel, bob } = await pair()
  const id = daniel.post('oi')
  await until(() => bob.secrets.has(id))
  daniel.remove(id)
  await until(() => bob.read()[0]?.deleted)

  for (const peer of [daniel, bob]) {
    assert.deepStrictEqual(peer.read()[0], { id, author: daniel.keys.publicKey, clock: 1, deleted: true, text: null })
    assert.strictEqual(peer.secrets.has(id), false)
    const box = peer.logs.get(daniel.keys.publicKey).get(0).box
    assert.ok(box.length > 0) // the op is still there, unreadable
  }
  daniel.close()
  bob.close()
})

test('should not let anyone but the author delete a message', async () => {
  const { daniel, bob } = await pair()
  const id = daniel.post('oi')
  await until(() => screen(bob)[0] === 'oi')
  bob.remove(id)
  await until(() => daniel._length(bob.keys.publicKey) === 1) // bob's delete arrived
  assert.deepStrictEqual(screen(daniel), ['oi'])
  assert.deepStrictEqual(screen(bob), ['oi'])
  daniel.close()
  bob.close()
})

test('should recover lost messages, tombstones and keys with sync', async () => {
  const { daniel, bob } = await pair({ loss: 1 }) // every packet dropped
  daniel.post('oi')
  const gone = daniel.post('wrong chat')
  daniel.remove(gone)
  bob.post('hey')
  await wait(50)
  assert.deepStrictEqual(screen(bob), ['hey'])

  daniel.loss = bob.loss = 0
  await until(() => screen(daniel).length === 3 && screen(bob).length === 3 && bob.secrets.size === 2, {
    sync: [daniel, bob],
  })
  assert.deepStrictEqual(screen(daniel), screen(bob))
  assert.ok(screen(bob).includes('(deleted)'))
  assert.strictEqual(bob.secrets.has(gone), false)
  daniel.close()
  bob.close()
})

test('should converge with delayed and duplicated packets', async t => {
  let random = 0.1 // < 0.3: every packet is sent twice, 20 ms late
  t.mock.method(Math, 'random', () => random)
  const { daniel, bob } = await pair({ chaos: true })
  const id = daniel.post('oi')
  bob.post('hey')
  await until(() => screen(daniel).length === 2 && screen(bob).length === 2 && bob.secrets.has(id))

  random = 0.9 // >= 0.3: sent once, 180 ms late
  daniel.remove(id)
  await until(() => bob.read().some(m => m.deleted))
  assert.deepStrictEqual(screen(daniel), screen(bob))
  daniel.close()
  bob.close()
})

test('should drop delayed and new sends after close instead of crashing', async t => {
  t.mock.method(Math, 'random', () => 0.9) // 180 ms delay
  const { daniel, bob } = await pair({ chaos: true })
  daniel.post('oi') // its packets are still waiting in timers
  daniel.close()
  daniel.sync() // closed: returns before touching the socket
  await wait(250) // the timers fire and see `closed`
  assert.deepStrictEqual(screen(bob), [])
  bob.close()
})

test('should ignore garbage, strangers and malformed messages', async () => {
  const { daniel, bob } = await pair()
  const id = daniel.post('oi')
  const danielPort = bob.peers[0].port
  const bobAddress = { address: '127.0.0.1', port: daniel.peers[0].port } // a peer daniel knows
  const evil = await stranger()

  // not JSON
  evil.send('not json', danielPort)
  // a stranger asking for everything, or pushing a key
  evil.send(JSON.stringify({ t: 'have', have: {} }), danielPort)
  evil.send(JSON.stringify({ t: 'key', id: 'x', key: 'y' }), danielPort)
  await wait(100)
  assert.deepStrictEqual(evil.received, []) // daniel answered nothing
  assert.strictEqual(daniel.secrets.has('x'), false)

  // malformed messages from a known peer
  for (const msg of [
    { t: 'have', have: null },
    { t: 'have', have: 5 },
    { t: 'key', id: 5, key: 'k' },
    { t: 'key', id: 'x', key: 5 },
    { t: 'nope' },
  ]) {
    daniel._onmessage(Buffer.from(JSON.stringify(msg)), bobAddress)
  }
  assert.deepStrictEqual([...daniel.secrets.keys()], [id])

  // a known peer cannot overwrite a key daniel already has
  const key = daniel.secrets.get(id)
  daniel._onmessage(Buffer.from(JSON.stringify({ t: 'key', id, key: 'wrong' })), bobAddress)
  assert.strictEqual(daniel.secrets.get(id), key)
  assert.deepStrictEqual(screen(daniel), ['oi'])

  evil.socket.close()
  daniel.close()
  bob.close()
})

test('should refuse ops with a bad signature, seq or clock, and keep the first op for a seq', () => {
  const peer = new Peer()
  const author = keyPair()
  const op = fields => sign({ type: 'msg', iv: 'x', box: 'y', ...fields }, author)

  peer._store({ ...op({ seq: 0, clock: 1 }), author: peer.keys.publicKey }) // forged author
  for (const bad of [
    { seq: -1, clock: 1 },
    { seq: 1.5, clock: 1 },
    { seq: '0', clock: 1 },
    { seq: 0, clock: 0 },
  ]) {
    peer._store(op(bad))
  }
  assert.strictEqual(peer.logs.size, 0)

  const first = op({ seq: 0, clock: 1, box: 'first' })
  peer._store(first)
  peer._store(op({ seq: 0, clock: 1, box: 'second' })) // same seq, other content
  assert.strictEqual(peer.logs.get(author.publicKey).get(0), first)
  assert.strictEqual(peer._length(author.publicKey), 1)
  peer.socket.close()
})

test('should move the clock forward to what the sender had seen', () => {
  const peer = new Peer()
  peer._store(sign({ type: 'msg', iv: 'x', box: 'y', seq: 0, clock: 10 }, keyPair()))
  assert.strictEqual(peer.clock, 10)
  peer.post('reply')
  assert.strictEqual(peer.read().at(-1).clock, 11) // after the message it has seen
  peer.socket.close()
})

test('should answer a have with only the missing ops, plus every key', t => {
  const peer = new Peer()
  for (const text of ['a', 'b', 'c']) peer.post(text)
  const sent = []
  t.mock.method(peer, '_send', msg => sent.push(msg))
  const me = peer.keys.publicKey

  peer._onhave({ [me]: 1 }, {})
  assert.deepStrictEqual(
    sent.filter(m => m.t === 'op').map(m => m.op.seq),
    [1, 2],
  )
  assert.strictEqual(sent.filter(m => m.t === 'key').length, 3)

  sent.length = 0
  peer._onhave({}, {}) // a peer that never heard of me gets my whole log
  assert.deepStrictEqual(
    sent.filter(m => m.t === 'op').map(m => m.op.seq),
    [0, 1, 2],
  )
  peer.socket.close()
})

test('should accept a host in connect and count only the run without gaps', () => {
  const peer = new Peer()
  peer.connect(5000, 'localhost')
  assert.deepStrictEqual(peer.peers, [{ host: 'localhost', port: 5000 }])
  const log = peer._log('someone')
  for (const seq of [0, 1, 2, 4]) log.set(seq, {})
  assert.strictEqual(peer._length('someone'), 3) // 3 is missing
  peer.socket.close()
})
