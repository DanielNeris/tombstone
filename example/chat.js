// Two peers chatting over UDP on a bad network: half the packets lost,
// the rest delayed and sometimes duplicated. One message is deleted.
//
//   node example/chat.js

const { Peer } = require('../lib/peer')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const daniel = new Peer({ chaos: true, loss: 0.5 })
  const bob = new Peer({ chaos: true, loss: 0.5 })

  daniel.connect(await bob.listen())
  bob.connect(await daniel.listen())

  const names = { [daniel.keys.publicKey]: 'daniel', [bob.keys.publicKey]: 'bob' }
  const show = peer =>
    peer
      .read()
      .map(m => `  [${m.clock}] ${names[m.author]}: ${m.deleted ? '(message deleted)' : (m.text ?? '(no key yet)')}`)
      .join('\n')

  // The `have` packets get lost too, so repeat until both sides match.
  const syncAll = async () => {
    for (let round = 0; round < 20; round++) {
      daniel.sync()
      bob.sync()
      await wait(100)
    }
  }

  const oi = daniel.post('oi')
  bob.post('hey') // written at the same time as oi: same clock, the author key decides
  await syncAll()

  daniel.remove(oi)
  daniel.post('how are you guys ?')
  await syncAll()

  bob.post('good, and you?') // bob has seen the question: it must come after it
  await syncAll()

  console.log(`daniel sees:\n${show(daniel)}\n`)
  console.log(`bob sees:\n${show(bob)}\n`)

  const raw = bob.logs.get(daniel.keys.publicKey).get(0) // oi is daniel's seq 0
  console.log('oi is still in bob log, encrypted:', raw.box)
  console.log('bob still has its key:', bob.secrets.has(oi))
  console.log('daniel still has its key:', daniel.secrets.has(oi))

  daniel.close()
  bob.close()
}

main()
