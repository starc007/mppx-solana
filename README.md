# mppx-solana

Solana SPL token payments for the [Machine Payments Protocol](https://github.com/mppxyz/mppx) (MPP) via HTTP 402.

Enables servers to charge for API access in any SPL token, and clients (browsers, Node.js apps, AI agents) to pay automatically — no manual invoicing, no subscriptions.

```
Client                           Server
  │                                 │
  │── POST /api/data ───────────────▶│
  │                                 │ 402 Payment Required
  │◀── WWW-Authenticate: MPP ───────│ (challenge + mint + amount)
  │                                 │
  │  [pays on Solana devnet/mainnet] │
  │                                 │
  │── POST /api/data ───────────────▶│ (credential in header)
  │                                 │ 200 OK + MPP-Receipt
  │◀────────────────────────────────│
```

## Installation

```bash
npm install mppx-solana mppx @solana/web3.js @solana/spl-token
```

## Quick Start

### Server (Node.js / Bun / Edge)

```ts
import { Hono } from 'hono'
import { solana, Store, Mppx } from 'mppx-solana/server'
import { PublicKey } from '@solana/web3.js'

const chargeMethod = solana.charge({
  recipient: new PublicKey('YOUR_WALLET_ADDRESS'),
  mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC
  network: 'mainnet-beta',
  store: Store.memory(), // use a persistent store in production
})

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [chargeMethod],
})

const app = new Hono()

app.all('/api/data', async (c) => {
  const result = await mppx['solana/charge']({ amount: '0.10' })(c.req.raw)

  if (result.status === 402) return result.challenge

  return result.withReceipt(
    new Response(JSON.stringify({ data: 'your protected content' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  )
})
```

### Client (Browser / Node.js)

```ts
import { solana, Mppx } from 'mppx-solana/client'

// Works with any Solana wallet (Phantom, Backpack, Solflare, keypair, agent wallet...)
const chargeClient = solana.charge({
  wallet: window.solana, // or any WalletLike
  network: 'mainnet-beta',
})

const mppxClient = Mppx.create({ methods: [chargeClient] })

// Automatically handles the 402 → pay → retry flow
const response = await mppxClient.fetch('https://yourapi.com/api/data')
const data = await response.json()
```

## Payments

### One-time Charge

Charge per request. Each call requires a fresh on-chain transaction.

**Server:**
```ts
import { solana, Store, Mppx } from 'mppx-solana/server'

const method = solana.charge({
  recipient: new PublicKey('...'),
  mint: new PublicKey('...'),  // any SPL token
  decimals: 6,                 // optional — auto-detected if omitted
  network: 'mainnet-beta',
  store: Store.memory(),
  verifyTimeout: 60_000,
})
```

**Client:**
```ts
import { solana, Mppx } from 'mppx-solana/client'

const method = solana.charge({
  wallet: myWallet,
  network: 'mainnet-beta',
  priorityFee: 'dynamic',  // 'fixed' | 'dynamic' | { microLamports: 5000 }
})
```

### Sessions (Deposit-based)

Client deposits a lump sum upfront. Server deducts per request from the balance. Refunds unused balance on close. Ideal for AI agents making many calls.

**Server:**
```ts
import { solana, Store, Mppx } from 'mppx-solana/server'
import { Keypair } from '@solana/web3.js'

const method = solana.session({
  recipient: new PublicKey('...'),
  mint: new PublicKey('...'),
  serverKeypair: Keypair.fromSecretKey(bs58.decode(process.env.SERVER_KEYPAIR!)),
  network: 'mainnet-beta',
  store: Store.memory(), // required — sessions need persistent state
})
```

**Client:**
```ts
import { solana, Mppx } from 'mppx-solana/client'

const method = solana.session({
  wallet: agentWallet,
  network: 'mainnet-beta',
})

const mppxClient = Mppx.create({ methods: [method] })

// First request: deposits funds and opens session
const r1 = await mppxClient.fetch('/api/endpoint')
method.setSessionFromResponse(r1) // capture sessionId + bearer

// Subsequent requests: deduct from session balance (no new tx)
const r2 = await mppxClient.fetch('/api/endpoint')
const r3 = await mppxClient.fetch('/api/endpoint')

// Top up when balance runs low
method.topUp()
const r4 = await mppxClient.fetch('/api/endpoint') // sends new deposit tx

// Close session and receive refund
method.close()
await mppxClient.fetch('/api/endpoint')
```

### Multi-token Router

Accept multiple tokens simultaneously. One endpoint, any token the client wants to pay with.

```ts
import { solana, Store, Mppx } from 'mppx-solana/server'
import { PaymentRouter } from 'mppx-solana/router'

const store = Store.memory() // shared — prevents cross-token replay

const router = new PaymentRouter({
  methods: [
    solana.charge({ recipient, mint: USDC_MINT, store, network: 'mainnet-beta' }),
    solana.charge({ recipient, mint: USDT_MINT, store, network: 'mainnet-beta' }),
  ],
})
```

## Wallet Compatibility

Any object that implements `WalletLike` works as a wallet:

```ts
interface WalletLike {
  publicKey: PublicKey
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>
}
```

This includes:
- **Phantom / Backpack / Solflare** — `window.solana` directly
- **`@solana/wallet-adapter-react`** — `useWallet()` adapter
- **Solana Agent Kit** — agent wallets
- **`Keypair`** — wrap with a simple adapter for server-side signing:

```ts
const wallet = {
  publicKey: keypair.publicKey,
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    (tx as VersionedTransaction).sign([keypair])
    return tx
  },
}
```

## RPC Configuration

```ts
// Single endpoint
solana.charge({ connection: new Connection('https://rpc.example.com'), ... })

// Multiple endpoints — automatic failover with exponential backoff
solana.charge({ endpoints: ['https://rpc1.example.com', 'https://rpc2.example.com'], ... })

// Named network (uses public endpoints)
solana.charge({ network: 'devnet', ... })
```

## Replay Protection

Pass a persistent `Store` to prevent the same transaction being accepted twice:

```ts
import { Store } from 'mppx-solana/server'

// In-memory (development)
const store = Store.memory()

// Production: use a persistent store adapter
// e.g. KV stores, Redis, Cloudflare KV, Durable Objects
```

A console warning is emitted if `store` is omitted from `solana.charge()`.

## Environment Variables

For the server only — the SDK itself reads nothing from the environment:

```bash
MPP_SECRET_KEY=<32-byte hex>   # for Mppx.create() — sign/verify challenges
```

## License

MIT
