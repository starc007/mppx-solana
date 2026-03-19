import type { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'

/**
 * Any Solana wallet that can sign transactions.
 * Compatible with Phantom, Solflare, Backpack, @solana/wallet-adapter-react,
 * Solana Agent Kit, and any custom signer — as long as it supports sign-only mode.
 *
 * Note: adapters that only expose sendTransaction (no signTransaction) are NOT compatible.
 */
export interface WalletLike {
  publicKey: PublicKey
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>
}
