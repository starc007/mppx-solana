import { Method, Receipt, Store } from 'mppx'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddress } from '@solana/spl-token'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { charge as chargeMethod } from '../methods/charge.js'
import { resolvePool, type SolanaNetwork } from '../core/rpc.js'
import { detectDecimals, parseAmount } from '../core/utils.js'
import { ReplayError } from '../core/errors.js'
import { verifyTransfer } from './verify.js'

export namespace charge {
  export interface Parameters {
    /** Recipient wallet address. SDK derives the ATA. */
    recipient: PublicKey
    mint: PublicKey
    /** Token decimals. Auto-detected from on-chain mint info if omitted. */
    decimals?: number
    /** Single RPC endpoint. Use `endpoints` for failover. */
    connection?: Connection
    /** Multiple RPC endpoints — enables automatic failover. Takes precedence over `connection`. */
    endpoints?: string[]
    network?: SolanaNetwork
    /**
     * Replay protection store. Strongly recommended in production.
     * If omitted, a console.warn is emitted and payments are processed without replay protection.
     */
    store?: Store.Store
    /** How long to wait for transaction confirmation. Default: 60000ms */
    verifyTimeout?: number
    /**
     * Secret key for HMAC-SHA256 receipt references.
     * When provided, the receipt `reference` field contains `HMAC(secret, signature)`
     * instead of the raw Solana tx signature, preventing receipt-based deanonymization.
     * Recommended: 32 bytes. Any length is accepted by HMAC-SHA256.
     */
    receiptSecret?: Uint8Array
  }
}

export function charge(params: charge.Parameters) {
  const { recipient, mint, network = 'mainnet-beta', verifyTimeout = 60_000 } = params

  if (!params.store) {
    console.warn(
      '[mpp-solana] solana.charge() instantiated without a store — replay protection is disabled. ' +
      'Pass store: Store.memory() or a persistent store in production.',
    )
  }

  const pool = resolvePool({
    connection: params.connection,
    endpoints: params.endpoints,
    network,
  })

  // Per-signature mutex: prevents concurrent requests with the same signature from
  // both passing the replay check before either writes the consumed key.
  const signatureLocks = new Map<string, Promise<void>>()

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = signatureLocks.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const next = new Promise<void>(r => { unlock = r })
    signatureLocks.set(key, next)
    try {
      await prev
      return await fn()
    } finally {
      unlock()
      if (signatureLocks.get(key) === next) signatureLocks.delete(key)
    }
  }

  return Method.toServer(chargeMethod, {
    // `defaults` provide the schema shape for type-checking.
    // All fields except `currency` and `network` are intentionally empty/zero here;
    // the `request()` hook below returns the fully populated values that mppx uses.
    defaults: {
      currency: mint.toBase58(),
      methodDetails: {
        recipient: '',   // overridden in request()
        mint: mint.toBase58(),
        decimals: 0,     // overridden in request()
        reference: '',   // overridden in request()
        network,
      },
    },

    async request({ credential, request }) {
      // If credential is present, client is retrying — reuse the original challenge
      if (credential) return credential.challenge.request as typeof request

      return pool.withConnection(async (connection, url) => {
        const decimals = params.decimals ?? (await detectDecimals(mint, url, connection))
        const reference = Keypair.generate().publicKey.toBase58()

        // This returned object fully populates all methodDetails fields.
        // mppx uses this return value as the challenge — defaults are not merged in.
        return {
          ...request,
          currency: mint.toBase58(),
          methodDetails: {
            recipient: recipient.toBase58(),
            mint: mint.toBase58(),
            decimals,
            reference,
            network,
          },
        }
      })
    },

    async verify({ credential }) {
      const { signature } = credential.payload
      const { methodDetails, amount } = credential.challenge.request

      return withLock(signature, async () => {
        if (params.store) {
          const key = `solana:charge:consumed:${signature}`
          if (await params.store.get(key)) throw new ReplayError(signature)
        }

        await pool.withConnection(async (connection) => {
          const recipientAta = await getAssociatedTokenAddress(
            new PublicKey(methodDetails.mint),
            new PublicKey(methodDetails.recipient),
          )
          await verifyTransfer(connection, {
            signature,
            reference: new PublicKey(methodDetails.reference),
            expectedRecipientAta: recipientAta,
            expectedMint: new PublicKey(methodDetails.mint),
            expectedAmount: parseAmount(amount, methodDetails.decimals),
            timeoutMs: verifyTimeout,
          })
        })

        if (params.store) {
          await params.store.put(`solana:charge:consumed:${signature}`, true)
        }

        const ref = params.receiptSecret
          ? bytesToHex(hmac(sha256, params.receiptSecret, new TextEncoder().encode(signature)))
          : signature

        return Receipt.from({
          method: 'solana',
          reference: ref,
          status: 'success',
          timestamp: new Date().toISOString(),
        })
      })
    },
  })
}
