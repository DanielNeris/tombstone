// A chat peer over UDP: writes its own log, keeps copies of everyone else's,
// and keeps them in sync on a network that loses, delays and duplicates packets.
//
// Three kinds of packet, one JSON object each:
//   op     a signed op: a message or a delete
//   have   "of each author's log I have this many": the other side sends the rest
//   key    the key of one message. It never goes in a log, so it can be thrown away
//
// What a peer keeps, from the bottom up:
//   logs     one append-only log per author, mine included (log.js). Only grows
//   view     what those ops mean: messages and tombstones (view.js)
//   secrets  message keys. A deleted message loses its key here (_shred)

const dgram = require('dgram')
const { Log } = require('./log')
const { View } = require('./view')
const { keyPair, sign, verify } = require('./identity')
const { secret, seal, open } = require('./secret')

class Peer {
  constructor({ admins, chaos = false, loss = 0 } = {}) {
    this.keys = keyPair()
    this.view = new View({ admins })
    this.logs = new Map() // author -> Log, my own log included
    this.secrets = new Map() // message id -> key. Never goes in a log
    this.peers = [] // { host, port } of every other peer
    this.chaos = chaos
    this.clock = 0 // Lamport clock: highest clock I've seen
    this.loss = loss // fraction of packets dropped on purpose, 0 to 1
    this.closed = false // set by close(): delayed chaos sends check it
    this.socket = dgram.createSocket('udp4')
    this.socket.on('message', (buf, rinfo) => this._onmessage(buf, rinfo))
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // Start listening on UDP. Port 0 lets the OS pick a free one. Resolves with the port.
  listen(port = 0) {
    return new Promise(resolve => this.socket.bind(port, '127.0.0.1', () => resolve(this.socket.address().port)))
  }

  // Add a peer to talk to. Only these get my keys, and only these can ask for them.
  connect(port, host = '127.0.0.1') {
    this.peers.push({ host, port })
  }

  close() {
    this.closed = true
    this.socket.close()
  }

  // ---------------------------------------------------------------------------
  // Public API: post, remove, sync, read
  // ---------------------------------------------------------------------------

  // Encrypt with a key only this message uses. The id is author/seq, so nobody can reuse it.
  // The key goes out in its own packet: the op in the log carries ciphertext only.
  post(text) {
    const key = secret()
    const op = this._publish({ type: 'msg', ...seal(text, key) })
    const id = `${op.author}/${op.seq}`
    this.secrets.set(id, key)
    for (const peer of this.peers) this._send({ t: 'key', id, key }, peer)
    return id
  }

  // Publish a tombstone. Each peer checks the permission when it applies it.
  remove(id) {
    this._publish({ type: 'delete', target: id })
  }

  // Tell every peer how much of each log I have. They answer with what I'm missing.
  // Call it now and then: a lost `have` is fixed by the next one (anti-entropy).
  sync() {
    const have = {}
    for (const [author, log] of this.logs) have[author] = log.length
    for (const peer of this.peers) this._send({ t: 'have', have }, peer)
  }

  // What the UI shows: the shared view, opened with the keys this peer holds.
  // text is null for a deleted message, and for one whose key hasn't arrived yet.
  read() {
    return this.view.messages().map(m => {
      const key = this.secrets.get(m.id)
      const text = m.deleted || !key ? null : open(m, key) // deleted first: never open a deleted message
      return { id: m.id, author: m.author, clock: m.clock, deleted: m.deleted, text }
    })
  }

  // ---------------------------------------------------------------------------
  // Writing and storing ops
  // ---------------------------------------------------------------------------

  // Number the op as the next one in my log, sign it, keep it and send it.
  // seq and clock go in before signing, so nobody can change them.
  _publish(op) {
    const signed = sign({ ...op, seq: this._log(this.keys.publicKey).length, clock: this.clock + 1 }, this.keys)
    this._store(signed)
    for (const peer of this.peers) this._send({ t: 'op', op: signed }, peer)
    return signed
  }

  // Every op enters through here, mine or from the network.
  _store(op) {
    if (!verify(op)) return // can't keep garbage in someone's log
    if (!Number.isInteger(op.seq) || op.seq < 0) return
    if (!Number.isInteger(op.clock) || op.clock < 1) return
    if (!this._log(op.author).put(op.seq, op)) return // duplicate: that seq is taken
    this.clock = Math.max(this.clock, op.clock) // carry forward what the sender had seen
    this.view.apply(op)
    this._shred() // this op may be the tombstone of a message whose key I hold
  }

  // The log of one author, created empty the first time.
  _log(author) {
    let log = this.logs.get(author)
    if (!log) {
      log = new Log()
      this.logs.set(author, log)
    }
    return log
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  // With chaos on, every packet is delayed 0-200 ms and 30% are sent twice.
  // `loss` drops packets before they leave, to test that sync recovers them.
  _send(msg, { host, port }) {
    if (this.closed) return
    if (Math.random() < this.loss) return
    const buf = Buffer.from(JSON.stringify(msg))
    if (!this.chaos) return this.socket.send(buf, port, host)
    const copies = Math.random() < 0.3 ? 2 : 1
    for (let i = 0; i < copies; i++) {
      setTimeout(() => {
        if (!this.closed) this.socket.send(buf, port, host) // the timer may fire after close()
      }, Math.random() * 200)
    }
  }

  // One packet arrived. Ops are signed, so they're accepted from anyone;
  // `have` and `key` only from peers I connected to.
  _onmessage(buf, rinfo) {
    let msg
    try {
      msg = JSON.parse(buf)
    } catch {
      return // garbage from the network
    }
    if (msg.t === 'op') this._store(msg.op)
    else if (msg.t === 'have' && this._known(rinfo) && typeof msg.have === 'object' && msg.have !== null) {
      this._onhave(msg.have, { host: rinfo.address, port: rinfo.port })
    } else if (msg.t === 'key' && this._known(rinfo) && typeof msg.id === 'string' && typeof msg.key === 'string') {
      if (!this.secrets.has(msg.id)) this.secrets.set(msg.id, msg.key) // never overwrite a key I already have
      this._shred() // the tombstone may have arrived first: then this key dies right away
    }
  }

  // They told me how much of each log they have: send them everything after that.
  // Keys go too, since a key packet can be lost like any other.
  _onhave(have, from) {
    for (const [author, log] of this.logs) {
      const theirs = have[author] ?? 0 // they may not know this author at all
      for (let seq = theirs; log.has(seq); seq++) {
        this._send({ t: 'op', op: log.get(seq) }, from)
      }
    }
    for (const [id, key] of this.secrets) this._send({ t: 'key', id, key }, from)
  }

  // Only peers I connected to get keys, and only they can ask me for them.
  // Answering anyone would hand every key to whoever asks, and let a forged
  // source address turn me into a reflector.
  _known({ address, port }) {
    return this.peers.some(p => p.host === address && p.port === port)
  }

  // ---------------------------------------------------------------------------
  // Crypto-shredding
  // ---------------------------------------------------------------------------

  // Throw away the key of every deleted message. Without it the box in the log is noise.
  _shred() {
    this.view.messages().forEach(m => {
      if (m.deleted) this.secrets.delete(m.id)
    })
  }
}

module.exports = { Peer }
