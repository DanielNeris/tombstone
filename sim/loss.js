// How many sync rounds two peers need to converge as the network gets worse.
//
// Each trial: daniel posts 5 messages and deletes 2, bob posts 5, all at once,
// with chaos on (packets delayed 0-200 ms, 30% duplicated) and `loss` of them dropped.
// Then both sync every 250 ms until their screens match and both deleted keys are gone.
//
//   node sim/loss.js            20 trials per loss rate
//   node sim/loss.js 5          5 trials per loss rate

const { Peer } = require('../lib/peer')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const trials = Number(process.argv[2]) || 20

async function trial(loss) {
  const daniel = new Peer({ chaos: true, loss })
  const bob = new Peer({ chaos: true, loss })
  daniel.connect(await bob.listen())
  bob.connect(await daniel.listen())

  const ids = []
  for (let i = 0; i < 5; i++) ids.push(daniel.post(`daniel ${i}`))
  for (let i = 0; i < 5; i++) bob.post(`bob ${i}`)
  daniel.remove(ids[0])
  daniel.remove(ids[1])
  await wait(250) // let the first packets land

  // Converged: same 10 messages in the same order, every live one readable, deleted keys gone.
  const screen = peer => JSON.stringify(peer.read())
  const readable = peer => peer.read().every(m => m.deleted || m.text !== null)
  const done = () =>
    screen(daniel) === screen(bob) &&
    bob.read().length === 10 &&
    readable(daniel) &&
    readable(bob) &&
    !bob.secrets.has(ids[0]) &&
    !bob.secrets.has(ids[1])

  const withoutSync = done()
  let rounds = 0
  while (!done()) {
    daniel.sync()
    bob.sync()
    rounds++
    await wait(250)
  }
  daniel.close()
  bob.close()
  return { withoutSync, rounds }
}

async function main() {
  console.log(`${trials} trials per loss rate, 10 messages and 2 deletes each\n`)
  for (const loss of [0, 0.1, 0.3, 0.5, 0.7]) {
    const results = []
    for (let i = 0; i < trials; i++) results.push(await trial(loss))
    const avg = results.reduce((sum, r) => sum + r.rounds, 0) / trials
    const max = Math.max(...results.map(r => r.rounds))
    const clean = results.filter(r => r.withoutSync).length
    console.log(
      `loss ${String(loss * 100).padStart(2)}%: ${clean}/${trials} converged without sync, ${avg.toFixed(1)} rounds on average, ${max} at most`,
    )
  }
}

main()
