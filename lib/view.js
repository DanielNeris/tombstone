const { verify } = require('./identity')

class View {
  constructor({ admins = [] } = {}) {
    this._msgs = new Map()
    this._pending = new Map() // message id -> deletes that arrived before it
    this._admins = new Set(admins)
  }

  // Fold one op into the current state. A delete only marks the message.
  apply(op) {
    if (!verify(op)) return
    if (op.type === 'msg') {
      if (this._msgs.has(op.id)) return
      this._msgs.set(op.id, { id: op.id, author: op.author, text: op.text, clock: op.clock, deleted: false })
      for (const del of this._pending.get(op.id) ?? []) this._delete(del)
      this._pending.delete(op.id)
    } else if (op.type === 'delete') {
      const msg = this._msgs.get(op.target)
      if (!msg) {
        const waiting = this._pending.get(op.target) ?? []
        waiting.push(op)
        this._pending.set(op.target, waiting)
        return
      }
      this._delete(op)
    }
  }

  // What the UI shows, in the same order on every peer: Lamport clock first,
  // author key to break ties. Deleted messages keep their place but lose their text.
  messages() {
    return [...this._msgs.values()]
      .sort((a, b) => a.clock - b.clock || (a.author < b.author ? -1 : 1))
      .map(m => ({ ...m, text: m.deleted ? null : m.text }))
  }

  // Rebuild the whole state by replaying the log from the start.
  static from(log, opts) {
    const view = new View(opts)
    for (const op of log) view.apply(op)
    return view
  }

  // Mark the target as deleted if the sender is its author or an admin.
  _delete(op) {
    const msg = this._msgs.get(op.target)
    const allowed = op.author === msg.author || this._admins.has(op.author)
    if (allowed) this._msgs.set(op.target, { ...msg, deleted: true })
  }
}

module.exports = { View }
