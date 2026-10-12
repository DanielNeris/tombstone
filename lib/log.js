// One author's append-only log: ops are never changed, removed or replaced.
//
// Every op has a seq, its position in the author's log counting from 0. This is the
// shape of a Hypercore: history is never edited, so deleting has to be a new op at
// the end (a tombstone) that says "hide that one", not a removal.
//
// Over a network, ops arrive out of order: seq 4 can come before seq 3. So the log
// keeps ops by seq in a Map, and `length` counts only the run with no gap from 0.
// A Map and not an array: an op with seq 1000000000 would leave a huge hole in an array.

class Log {
  constructor() {
    this._ops = new Map() // seq -> op
    this._length = 0 // ops with no gap from 0
  }

  // Keep op at its seq. Returns false, and keeps the first one, if that seq is taken.
  put(seq, op) {
    if (this._ops.has(seq)) return false // a duplicate, or someone trying to rewrite history
    Object.freeze(op) // nobody can change it after it's in the log
    this._ops.set(seq, op)
    while (this._ops.has(this._length)) this._length++ // this op may close a gap
    return true
  }

  has(seq) {
    return this._ops.has(seq)
  }

  get(seq) {
    return this._ops.get(seq)
  }

  // How many ops I have with no gap from 0. With seqs 0, 1, 2 and 4 it's 3: number 3 is missing.
  // It's also the seq of the next op the author will write.
  get length() {
    return this._length
  }
}

module.exports = { Log }
