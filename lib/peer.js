const dgram = require('dgram')
const crypto = require('crypto')
const { View } = require('./view')
const { keyPair, sign, verify } = require('./identity')

class Peer {
  constructor({ admins, chaos = false } = {}) {
    this.keys = keyPair()
    this.view = new View({ admins })
    this.logs = new Map() // author -> Map(seq -> op), my own log included
    this.peers = [] // { host, port } of every other peer
    this.chaos = chaos
    this.socket = dgram.createSocket('udp4')
    this.socket.on('message', buf => this._onmessage(buf))
  }

  listen(port = 0) {
    return new Promise(resolve => this.socket.bind(port, '127.0.0.1', () => resolve(this.socket.address().port)))
  }

  connect(port, host = '127.0.0.1') {
    this.peers.push({ host, port })
  }

  post(text) {
    const id = crypto.randomBytes(4).toString('hex')
    this._publish({ type: 'msg', id, text })
    return id
  }

  remove(id) {
    this._publish({ type: 'delete', target: id })
  }

  // With chaos on, every packet is delayed 0-200 ms and 30% are sent twice.
  _send(op, { host, port }) {
    const buf = Buffer.from(JSON.stringify(op))
    if (!this.chaos) return this.socket.send(buf, port, host)
    const copies = Math.random() < 0.3 ? 2 : 1
    for (let i = 0; i < copies; i++) {
      setTimeout(() => this.socket.send(buf, port, host), Math.random() * 200)
    }
  }

  // Number the op as the next one in my log, sign it, keep it and send it.
  // seq goes in before signing, so nobody can renumber it.
  _publish(op) {
    const signed = sign({ ...op, seq: this._length(this.keys.publicKey) }, this.keys)
    this._store(signed)
    for (const peer of this.peers) this._send(signed, peer)
  }

  _store(op) {
    if (!verify(op)) return
    if (!Number.isInteger(op.seq) || op.seq < 0) return
    const log = this._log(op.author)
    if (log.has(op.seq)) return // duplicate
    log.set(op.seq, op)
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

  _onmessage(buf) {
    let op
    try {
      op = JSON.parse(buf)
    } catch {
      return
    } // garbage from the network
    this._store(op)
  }

  close() {
    this.socket.close()
  }
}

module.exports = { Peer }
