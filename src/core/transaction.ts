import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token'
import type { WalletLike } from '../types.js'
import type { PriorityFee } from './rpc.js'
import { TransactionExpiredError, SolanaPaymentError } from './errors.js'

export interface TransferParams {
  connection: Connection
  wallet: WalletLike
  /** SPL token mint */
  mint: PublicKey
  /**
   * Recipient **wallet address** (not ATA).
   * `buildAndSendTransfer` derives both the sender and recipient ATAs from this
   * and creates them idempotently in the transaction.
   */
  recipient: PublicKey
  /** Raw token units (use parseAmount to convert from human-readable) */
  amount: bigint
  decimals: number
  /**
   * Appended as a non-signer account key for on-chain discovery.
   * Optional — omit for internal transfers (e.g., refunds) that don't need discovery.
   */
  reference?: PublicKey
  priorityFee?: PriorityFee
}

async function resolvePriorityFee(
  connection: Connection,
  strategy: PriorityFee = 'fixed',
): Promise<number> {
  if (strategy === 'fixed') return 1000
  if (typeof strategy === 'object') return strategy.microLamports
  // dynamic: fetch recent median
  try {
    const fees = await connection.getRecentPrioritizationFees()
    if (!fees.length) return 1000
    const sorted = [...fees].sort((a, b) => a.prioritizationFee - b.prioritizationFee)
    return sorted[Math.floor(sorted.length / 2)].prioritizationFee
  } catch {
    return 1000
  }
}

/**
 * Build and send a VersionedTransaction (MessageV0).
 *
 * Design note: `recipient` is the **wallet address** (owner), not the ATA.
 * This function derives both ATAs internally so it can create them idempotently
 * in the same transaction (spec requirement: "both ATAs created idempotently").
 * Passing the ATA directly would prevent idempotent ATA creation for the recipient
 * because `createAssociatedTokenAccountIdempotentInstruction` requires the owner address.
 *
 * Steps:
 *   1. Derive senderAta and recipientAta from wallet.publicKey / recipient
 *   2. Ensures both ATAs exist (idempotent instructions, no-op if already created)
 *   3. Transfers `amount` tokens from senderAta to recipientAta
 *   4. Appends `reference` as a non-signer key for on-chain discovery (if provided)
 *
 * Returns the confirmed transaction signature.
 */
export async function buildAndSendTransfer(params: TransferParams): Promise<string> {
  const { connection, wallet, mint, recipient, amount, decimals, reference } = params

  const senderAta = await getAssociatedTokenAddress(mint, wallet.publicKey)
  const recipientAta = await getAssociatedTokenAddress(mint, recipient)
  const microLamports = await resolvePriorityFee(connection, params.priorityFee)

  // Build the transfer instruction; append reference as non-signer if provided
  const transferIx = createTransferCheckedInstruction(
    senderAta,
    mint,
    recipientAta,
    wallet.publicKey,
    amount,
    decimals,
  )
  if (reference) {
    transferIx.keys.push({ pubkey: reference, isSigner: false, isWritable: false })
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      // Idempotent: no-op if sender ATA already exists
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        senderAta,
        wallet.publicKey,
        mint,
      ),
      // Idempotent: no-op if recipient ATA already exists. Client pays rent.
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        recipientAta,
        recipient,
        mint,
      ),
      transferIx,
    ],
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  const signed = await wallet.signTransaction(tx)

  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
  })

  let result: Awaited<ReturnType<typeof connection.confirmTransaction>>
  try {
    result = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
  } catch (err) {
    // @solana/web3.js throws TransactionExpiredBlockheightExceededError when the
    // blockhash's lastValidBlockHeight is exceeded before confirmation
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('block height exceeded') || msg.includes('BlockhashNotFound')) {
      throw new TransactionExpiredError(signature)
    }
    throw err
  }

  if (result.value.err) {
    throw new SolanaPaymentError(
      `Transaction failed on-chain: ${JSON.stringify(result.value.err)}`,
    )
  }

  return signature
}
