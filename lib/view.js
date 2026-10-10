class View {
  constructor({ admins = [] } = {}) {
    this._msgs = new Map()
    this._admins = new Set(admins)
  }

  // Fold one op into the current state. A delete only marks the message.
  apply(op) {
    if (op.type === 'msg') this._msgs.set(op.id, { id: op.id, author: op.author, text: op.text, deleted: false })
    else if (op.type === 'delete') {
      const msg = this._msgs.get(op.target)
      if (!msg) return
      const allowed = op.author === msg.author || this._admins.has(op.author)
      if (allowed) this._msgs.set(op.target, { ...msg, deleted: true })
    }
  }

  // What the UI shows: deleted messages keep their place but lose their text.
  messages() {
    return [...this._msgs.values()].map(m => {
      return { ...m, text: m.deleted ? null : m.text }
    })
  }

  // Rebuild the whole state by replaying the log from the start.
  static from(log, opts) {
    const view = new View(opts)
    for (const op of log) view.apply(op)
    return view
  }
}

module.exports = { View }
