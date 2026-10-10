const dgram = require('dgram')
const crypto = require('crypto')
const { View } = require('./view')
const { keyPair, sign } = require('./identity')

class Peer {
  constructor({ admins, chaos = false } = {}) {
    this.keys = keyPair()
    this.view = new View({ admins })
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
    this._publish(sign({ type: 'msg', id, text }, this.keys))
    return id
  }

  remove(id) {
    this._publish(sign({ type: 'delete', target: id }, this.keys))
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

  _publish(op) {
    this.view.apply(op)
    for (const peer of this.peers) this._send(op, peer)
  }

  _onmessage(buf) {
    let op
    try {
      op = JSON.parse(buf)
    } catch {
      return
    } // garbage from the network
    this.view.apply(op)
  }

  close() {
    this.socket.close()
  }
}

module.exports = { Peer }
