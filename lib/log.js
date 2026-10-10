class Log {
  constructor() {
    this._ops = []
  }

  append(op) {
    Object.freeze(op) // nobody can change it after it's in the log
    const seq = this._ops.push(op) - 1
    return seq
  }

  get(seq) {
    return this._ops[seq]
  }

  get length() {
    return this._ops.length
  }

  [Symbol.iterator]() {
    return this._ops[Symbol.iterator]()
  }

}

module.exports = { Log }