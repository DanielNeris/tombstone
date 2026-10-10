const dgram = require('dgram')
const { View } = require('./view')
const { keyPair, sign, verify } = require('./identity')
const { secret, seal, open } = require('./secret')

class Peer {
  constructor({ admins, chaos = false, loss = 0 } = {}) {
    this.keys = keyPair()
    this.view = new View({ admins })
    this.logs = new Map() // author -> Map(seq -> op), my own log included
    this.secrets = new Map() // message id -> key. Never goes in a log
    this.peers = [] // { host, port } of every other peer
    this.chaos = chaos
    this.clock = 0 // Lamport clock: highest clock I've seen
    this.loss = loss // fraction of packets dropped on purpose, 0 to 1
    this.closed = false // set by close(): delayed chaos sends check it
    this.socket = dgram.createSocket('udp4')
    this.socket.on('message', (buf, rinfo) => this._onmessage(buf, rinfo))
  }

  listen(port = 0) {
    return new Promise(resolve => this.socket.bind(port, '127.0.0.1', () => resolve(this.socket.address().port)))
  }

  connect(port, host = '127.0.0.1') {
    this.peers.push({ host, port })
  }

  // Encrypt with a key only this message uses. The id is author/seq, so nobody can reuse it.
  post(text) {
    const key = secret()
    const op = this._publish({ type: 'msg', ...seal(text, key) })
    const id = `${op.author}/${op.seq}`
    this.secrets.set(id, key)
    return id
  }

  remove(id) {
    this._publish({ type: 'delete', target: id })
  }

  // Tell every peer how much of each log I have. They answer with what I'm missing.
  sync() {
    const have = {}
    for (const author of this.logs.keys()) have[author] = this._length(author)
    for (const peer of this.peers) this._send({ t: 'have', have }, peer)
  }

  // What the UI shows: the shared view, opened with the keys this peer holds.
  read() {
    return this.view.messages().map(m => {
      const key = this.secrets.get(m.id)
      const text = m.deleted || !key ? null : open(m, key)
      return { id: m.id, author: m.author, clock: m.clock, deleted: m.deleted, text }
    })
  }

  // With chaos on, every packet is delayed 0-200 ms and 30% are sent twice.
  _send(msg, { host, port }) {
    if (this.closed) return
    if (Math.random() < this.loss) return
    const buf = Buffer.from(JSON.stringify(msg))
    if (!this.chaos) return this.socket.send(buf, port, host)
    const copies = Math.random() < 0.3 ? 2 : 1
    for (let i = 0; i < copies; i++) {
      setTimeout(() => {
        if (!this.closed) this.socket.send(buf, port, host)
      }, Math.random() * 200)
    }
  }

  // Number the op as the next one in my log, sign it, keep it and send it.
  // seq goes in before signing, so nobody can renumber it.
  _publish(op) {
    const signed = sign({ ...op, seq: this._length(this.keys.publicKey), clock: this.clock + 1 }, this.keys)
    this._store(signed)
    for (const peer of this.peers) this._send({ t: 'op', op: signed }, peer)
    return signed
  }

  _store(op) {
    if (!verify(op)) return
    if (!Number.isInteger(op.seq) || op.seq < 0) return
    if (!Number.isInteger(op.clock) || op.clock < 1) return
    const log = this._log(op.author)
    if (log.has(op.seq)) return // duplicate
    log.set(op.seq, op)
    this.clock = Math.max(this.clock, op.clock) // carry forward what the sender had seen
    this.view.apply(op)
  }

  // The log of one author, created empty the first time.
  _log(author) {
    let log = this.logs.get(author)
    if (!log) {
      log = new Map()
      this.logs.set(author, log)
    }
    return log
  }

  // How many ops of this author I have with no gap from 0.
  // With seqs 0, 1, 2 and 4 it's 3: number 3 is missing.
  _length(author) {
    const log = this._log(author)
    let n = 0
    while (log.has(n)) n++
    return n
  }

  _onmessage(buf, rinfo) {
    let msg
    try {
      msg = JSON.parse(buf)
    } catch {
      return
    } // garbage from the network
    if (msg.t === 'op') this._store(msg.op)
    else if (msg.t === 'have' && typeof msg.have === 'object' && msg.have !== null) {
      this._onhave(msg.have, { host: rinfo.address, port: rinfo.port })
    }
  }

  // They told me how much of each log they have: send them everything after that.
  _onhave(have, from) {
    for (const [author, log] of this.logs) {
      const theirs = have[author] ?? 0 // they may not know this author at all
      for (let seq = theirs; log.has(seq); seq++) {
        this._send({ t: 'op', op: log.get(seq) }, from)
      }
    }
  }

  close() {
    this.closed = true
    this.socket.close()
  }
}

module.exports = { Peer }
