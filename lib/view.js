// The chat as the screen sees it, computed from ops.
//
// Every peer that has the same ops computes the same view, whatever order they
// arrived in and however many times. That is what makes it safe on a network:
//   - a delete only marks its message (a tombstone), it never removes it
//   - a delete that arrives before its message waits in _pending
//   - a message seen twice is ignored, so a late copy can't undo a delete
//   - messages are ordered by Lamport clock, then author key: the same everywhere
// apply() is commutative (order doesn't matter) and idempotent (repeats don't
// matter): the two properties that make this a CRDT.
//
// The view holds ciphertext only. Keys are local to each peer (see peer.js), and
// state that depended on them could differ between peers.

const { verify } = require('./identity')

class View {
  constructor({ admins = [] } = {}) {
    this._msgs = new Map() // message id -> { id, author, iv, box, clock, deleted }
    this._pending = new Map() // message id -> deletes that arrived before it
    this._admins = new Set(admins) // public keys allowed to delete anyone's message
  }

  // Fold one op into the current state. A delete only marks the message.
  apply(op) {
    if (!verify(op)) return // forged or changed: as if it never existed

    if (op.type === 'msg') {
      const id = `${op.author}/${op.seq}` // nobody else can sign with this author, so nobody can reuse it
      if (this._msgs.has(id)) return // a duplicate must not overwrite a tombstone
      this._msgs.set(id, { id, author: op.author, iv: op.iv, box: op.box, clock: op.clock, deleted: false })
      // Deletes that got here first run now, when we finally know who the author is.
      for (const del of this._pending.get(id) ?? []) this._delete(del)
      this._pending.delete(id)
    } else if (op.type === 'delete') {
      const msg = this._msgs.get(op.target)
      if (!msg) {
        // The message hasn't arrived yet. Dropping the delete would let it come back later.
        const waiting = this._pending.get(op.target) ?? []
        waiting.push(op)
        this._pending.set(op.target, waiting)
        return
      }
      this._delete(op)
    }
  }

  // Every message, in the same order on every peer: Lamport clock first, author key to break ties.
  // `<` and not localeCompare: locale rules differ between machines, plain comparison doesn't.
  messages() {
    return [...this._msgs.values()]
      .sort((a, b) => a.clock - b.clock || (a.author < b.author ? -1 : 1))
      .map(m => ({ ...m })) // copies: the caller can't change our state
  }

  // Mark the target as deleted if the sender is its author or an admin.
  // The check runs on every peer when the op is applied: there's no server to refuse it.
  _delete(op) {
    const msg = this._msgs.get(op.target)
    const allowed = op.author === msg.author || this._admins.has(op.author)
    if (allowed) this._msgs.set(op.target, { ...msg, deleted: true })
  }
}

module.exports = { View }
