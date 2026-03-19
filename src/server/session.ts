import { Method, Receipt, Store } from 'mppx'
import {
  Connection,
  Keypair,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from '@solana/web3.js'
import { getAssociatedTokenAddress } from '@solana/spl-token'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { session as sessionMethod } from '../methods/session.js'
import { resolvePool, type SolanaNetwork } from '../core/rpc.js'
import { detectDecimals, parseAmount } from '../core/utils.js'
import { ReplayError, SessionError, VerificationError } from '../core/errors.js'
import { computeTransferDelta, verifyTransfer, fetchWithTimeout } from './verify.js'
import { buildAndSendTransfer } from '../core/transaction.js'

interface SessionState {
  sessionId: string
  bearerHash: string
  depositAmount: bigint
  spent: bigint
  refundAddress: string
  mint: string
  decimals: number
  status: 'active' | 'closing' | 'closed'
}

interface SerializedSession extends Omit<SessionState, 'depositAmount' | 'spent'> {
  depositAmount: string
  spent: string
}

function serialize(s: SessionState): SerializedSession {
  return { ...s, depositAmount: s.depositAmount.toString(), spent: s.spent.toString() }
}

function deserialize(s: SerializedSession): SessionState {
  return { ...s, depositAmount: BigInt(s.depositAmount), spent: BigInt(s.spent) }
}

export namespace session {
  export interface Parameters {
    recipient: PublicKey
    mint: PublicKey
    decimals?: number
    /**
     * Dedicated hot-wallet for signing refund transactions.
     * Should hold only enough SOL for transaction fees.
     * Do NOT use your main treasury keypair.
     */
    serverKeypair: Keypair
    connection?: Connection
    endpoints?: string[]
    network?: SolanaNetwork
    /** Required — sessions cannot function without persistent state */
    store: Store.Store
    verifyTimeout?: number
  }
}

export function session(params: session.Parameters) {
  const {
    recipient,
    mint,
    serverKeypair,
    network = 'mainnet-beta',
    store,
    verifyTimeout = 60_000,
  } = params

  const pool = resolvePool({
    connection: params.connection,
    endpoints: params.endpoints,
    network,
  })

  const sessionLocks = new Map<string, Promise<void>>()

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = sessionLocks.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const next = new Promise<void>(r => { unlock = r })
    sessionLocks.set(key, next)
    try {
      await prev
      return await fn()
    } finally {
      unlock()
      if (sessionLocks.get(key) === next) sessionLocks.delete(key)
    }
  }

  async function loadSession(sessionId: string): Promise<SessionState> {
    const raw = await store.get<SerializedSession>(`solana:session:${sessionId}`)
    if (!raw) throw new SessionError(`Session not found: ${sessionId}`, sessionId)
    return deserialize(raw)
  }

  async function saveSession(state: SessionState): Promise<void> {
    await store.put(`solana:session:${state.sessionId}`, serialize(state))
  }

  function verifyBearer(state: SessionState, bearer: string): void {
    if (state.status !== 'active') {
      throw new SessionError(
        `Session ${state.sessionId} is ${state.status}`,
        state.sessionId,
      )
    }
    const hash = bytesToHex(sha256(new TextEncoder().encode(bearer)))
    if (hash !== state.bearerHash) {
      throw new SessionError(`Invalid bearer for session ${state.sessionId}`, state.sessionId)
    }
  }

  return Method.toServer(sessionMethod, {
    // `defaults` provide the schema shape; fully populated in request() below.
    defaults: {
      currency: mint.toBase58(),
      depositAmount: '0',
      methodDetails: {
        recipient: '',   // overridden in request()
        mint: mint.toBase58(),
        decimals: 0,     // overridden in request()
        reference: '',   // overridden in request()
        network,
      },
    },

    async request({ credential, request }) {
      if (credential) return credential.challenge.request as typeof request

      return pool.withConnection(async (connection, url) => {
        const decimals = params.decimals ?? (await detectDecimals(mint, url, connection))
        const reference = Keypair.generate().publicKey.toBase58()

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
      const { payload, challenge } = credential
      const { methodDetails, amount } = challenge.request

      switch (payload.action) {
        case 'open': {
          return withLock(`deposit:${payload.depositSignature}`, async () => {
            const consumedKey = `solana:session:deposit:${payload.depositSignature}`
            if (await store.get(consumedKey)) throw new ReplayError(payload.depositSignature)

            const depositAmountStr = challenge.request.depositAmount ?? amount
            await pool.withConnection(async (connection) => {
              const recipientAta = await getAssociatedTokenAddress(
                new PublicKey(methodDetails.mint),
                new PublicKey(methodDetails.recipient),
              )
              await verifyTransfer(connection, {
                signature: payload.depositSignature,
                reference: new PublicKey(methodDetails.reference),
                expectedRecipientAta: recipientAta,
                expectedMint: new PublicKey(methodDetails.mint),
                expectedAmount: parseAmount(depositAmountStr, methodDetails.decimals),
                timeoutMs: verifyTimeout,
              })
            })

            await store.put(consumedKey, true)

            // Generate a cryptographically random bearer.
            // Only the hash is stored; the plaintext is returned to the client ONCE.
            const bearerBytes = crypto.getRandomValues(new Uint8Array(32))
            const bearer = bytesToHex(bearerBytes)
            const bearerHash = bytesToHex(sha256(new TextEncoder().encode(bearer)))
            const sessionId = crypto.randomUUID()

            const depositAmount = parseAmount(depositAmountStr, methodDetails.decimals)
            const chargeAmount = parseAmount(amount, methodDetails.decimals)

            const state: SessionState = {
              sessionId,
              bearerHash,
              depositAmount,
              spent: chargeAmount,
              refundAddress: payload.refundAddress,
              mint: methodDetails.mint,
              decimals: methodDetails.decimals,
              status: 'active',
            }

            await saveSession(state)

            // Encode { sessionId, bearer } in receipt reference.
            // The client reads this from the MPP-Receipt header via setSessionFromResponse().
            return Receipt.from({
              method: 'solana',
              reference: JSON.stringify({ sessionId, bearer }),
              status: 'success',
              timestamp: new Date().toISOString(),
            })
          })
        }

        case 'bearer': {
          return withLock(payload.sessionId, async () => {
            const state = await loadSession(payload.sessionId)
            verifyBearer(state, payload.bearer)

            const chargeAmount = parseAmount(amount, methodDetails.decimals)
            const remaining = state.depositAmount - state.spent
            if (chargeAmount > remaining) {
              throw new SessionError(
                `Insufficient session balance: need ${chargeAmount}, have ${remaining}`,
                payload.sessionId,
              )
            }

            state.spent += chargeAmount
            await saveSession(state)

            return Receipt.from({
              method: 'solana',
              reference: payload.sessionId,
              status: 'success',
              timestamp: new Date().toISOString(),
            })
          })
        }

        case 'topUp': {
          return withLock(payload.sessionId, async () => {
            const consumedKey = `solana:session:topup:${payload.topUpSignature}`
            if (await store.get(consumedKey)) throw new ReplayError(payload.topUpSignature)

            const state = await loadSession(payload.sessionId)
            // Require bearer on top-up: only the legitimate session holder can add funds
            verifyBearer(state, payload.bearer)
            if (state.status !== 'active') {
              throw new SessionError(
                `Cannot top up a ${state.status} session`,
                payload.sessionId,
              )
            }

            const topUpAmount = await pool.withConnection(async (connection) => {
              // Use fetchWithTimeout to poll until confirmed (same as verifyTransfer)
              const tx = await fetchWithTimeout(
                connection,
                payload.topUpSignature,
                verifyTimeout,
              )
              if (tx.meta?.err) {
                throw new VerificationError(
                  `Top-up transaction failed: ${JSON.stringify(tx.meta.err)}`,
                )
              }

              const ref = new PublicKey(methodDetails.reference)
              const hasRef = tx.transaction.message.accountKeys.some(k => k.pubkey.equals(ref))
              if (!hasRef) {
                throw new VerificationError('Reference key not found in top-up transaction')
              }

              const recipientAta = await getAssociatedTokenAddress(
                new PublicKey(methodDetails.mint),
                new PublicKey(methodDetails.recipient),
              )
              const delta = computeTransferDelta(
                tx,
                recipientAta,
                new PublicKey(methodDetails.mint),
              )
              if (delta <= BigInt(0)) {
                throw new VerificationError('No positive transfer in top-up transaction')
              }
              return delta
            })

            await store.put(consumedKey, true)
            state.depositAmount += topUpAmount
            await saveSession(state)

            return Receipt.from({
              method: 'solana',
              reference: payload.sessionId,
              status: 'success',
              timestamp: new Date().toISOString(),
            })
          })
        }

        case 'close': {
          return withLock(payload.sessionId, async () => {
            const state = await loadSession(payload.sessionId)
            verifyBearer(state, payload.bearer)

            // Mark closing before sending refund to prevent double-refund on retry
            state.status = 'closing'
            await saveSession(state)

            const refundAmount = state.depositAmount - state.spent
            if (refundAmount > BigInt(0)) {
              // Wrap serverKeypair as WalletLike for buildAndSendTransfer.
              // buildAndSendTransfer always uses VersionedTransaction, so only that branch fires.
              const serverWallet = {
                publicKey: serverKeypair.publicKey,
                async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
                  (tx as VersionedTransaction).sign([serverKeypair])
                  return tx
                },
              }
              await pool.withConnection(async (connection) => {
                await buildAndSendTransfer({
                  connection,
                  wallet: serverWallet,
                  mint: new PublicKey(state.mint),
                  recipient: new PublicKey(state.refundAddress),
                  amount: refundAmount,
                  decimals: state.decimals,
                  // No reference key needed for refunds — not subject to on-chain discovery
                })
              })
            }
            // If refundAmount === 0, skip the on-chain refund transaction entirely.

            state.status = 'closed'
            await saveSession(state)

            return Receipt.from({
              method: 'solana',
              reference: payload.sessionId,
              status: 'success',
              timestamp: new Date().toISOString(),
            })
          })
        }

        default:
          throw new Error(`Unknown session action: ${(payload as { action: string }).action}`)
      }
    },

    async respond({ credential, receipt }) {
      const { payload } = credential
      // topUp and close don't gate a resource — return the receipt directly
      if (payload.action === 'topUp' || payload.action === 'close') {
        return new Response(JSON.stringify(receipt), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // open and bearer: let the caller use withReceipt() on their resource response
      return undefined
    },
  })
}
