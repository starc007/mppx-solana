# mpp-solana

Solana SPL token payment plugin for [mppx](https://mpp.dev) — HTTP 402 machine payments protocol.

## What this is

`mpp-solana` adds Solana SPL token support on top of mppx. mppx handles the HTTP 402 challenge/credential/receipt protocol. This library handles the on-chain side: building VersionedTransactions, verifying transfers, managing sessions, routing across multiple tokens.

## Commands

```bash
bun run build          # compile src/ → dist/
bun test               # all tests (unit + devnet)
bun test tests/unit    # unit tests only (no network needed)
bun test tests/devnet  # devnet integration tests (requires .env)
```

## Architecture

```
src/
  core/
    errors.ts       # typed error hierarchy (SolanaPaymentError base)
    rpc.ts          # ConnectionPool, resolvePool, isTransient, PriorityFee
    transaction.ts  # buildAndSendTransfer — single VersionedTransaction builder
    utils.ts        # parseAmount, detectDecimals, createDetectDecimals
  methods/
    charge.ts       # Method.from schema for one-time charges
    session.ts      # Method.from schema for persistent sessions
  server/
    charge.ts       # server charge handler (verify + replay protection)
    session.ts      # server session handler (open/bearer/topUp/close)
    verify.ts       # verifyTransfer, fetchWithTimeout, computeTransferDelta
    index.ts        # server barrel — exports solana.charge, solana.session
  client/
    charge.ts       # client charge handler (builds + sends tx)
    session.ts      # client session handler (manages bearer state)
    index.ts        # client barrel
  router/
    index.ts        # PaymentRouter — multi-token routing with shared replay store
  index.ts          # root barrel — errors + core types only
  types.ts          # WalletLike interface
```

## Key design decisions

**`recipient` is always a wallet address, never an ATA.** `buildAndSendTransfer` derives both sender and recipient ATAs internally and creates them idempotently. This lets the server advertise its wallet address in the challenge and derive the ATA for verification.

**`buildAndSendTransfer` is the single transfer function.** Refunds in the session close flow use the same function — no duplicate logic. The server wraps its `Keypair` in a `WalletLike` object to sign.

**Session bearer security.** Server generates a random 32-byte hex bearer, stores only `sha256(bearer)`. Bearer plaintext is returned once in the receipt `reference` as `JSON.stringify({ sessionId, bearer })`. TopUp requires the bearer to prevent unauthorized deposits.

**Cross-token replay protection.** Shared `Store` instance across all charge/session handlers. Consumed key format: `solana:charge:consumed:${signature}`.

**RPC pool failover.** `createConnectionPool` tries endpoints in order with exponential backoff (base 1s, max 8s). Only retries on transient errors (429, 503, ETIMEDOUT, ECONNRESET, fetch failed).

## v0.2 additions

**`receiptSecret` (server charge config).** Optional `Uint8Array`. When provided, the `Payment-Receipt` `reference` field contains `HMAC-SHA256(receiptSecret, signature)` instead of the raw tx signature. Prevents receipt-based deanonymization. Proxy operators can derive this from their existing `MPP_SECRET_KEY`:
```ts
receiptSecret: sha256(new TextEncoder().encode('mpp-receipt-hmac:' + process.env.MPP_SECRET_KEY))
```

**`onPayment` (client charge + session config).** Optional callback fired after each successful on-chain transaction.
- Charge: `onPayment?: (signature: string) => void`
- Session: `onPayment?: (signature: string, action: 'open' | 'topUp') => void`

Fire-and-forget — errors in the callback do not block the payment flow.

## Entry points

| Import | Use for |
|--------|---------|
| `mpp-solana/server` | server-side charge/session handlers |
| `mpp-solana/client` | client-side payment handlers |
| `mpp-solana/router` | multi-token PaymentRouter |
| `mpp-solana` | error classes + types only |

## Devnet tests

Require `.env` with:
- `SOLANA_RPC_URL` — devnet RPC endpoint
- `TEST_WALLET_PRIVATE_KEY` — funded devnet wallet (base58)
- `TEST_RECIPIENT_ADDRESS` — payment recipient public key
- `TEST_SERVER_KEYPAIR` — server keypair for session refunds
- `USDC_DEVNET_MINT` — devnet USDC mint
- `USDT_DEVNET_MINT` — devnet USDT mint (or any second SPL token)

The test wallet must hold tokens for both mints. Fund with:
```bash
spl-token transfer <MINT> 1000 <TEST_WALLET_ADDRESS> --url devnet --fund-recipient
```

## @noble/hashes import paths

This project uses `@noble/hashes` v2 which requires `.js` extension:
- `@noble/hashes/sha2.js` (not `@noble/hashes/sha256`)
- `@noble/hashes/utils.js` (not `@noble/hashes/utils`)

## mppx uses zod/mini

`mppx` re-exports zod/mini. Use functional form for optional fields:
- `z.optional(z.string())` — correct
- `z.string().optional()` — does not exist in zod/mini