import { Connection, Keypair, PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js'
import { decode as bs58Decode } from 'bs58'

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

/**
 * Wrap a Keypair as a WalletLike so it can be used with buildAndSendTransfer
 * and the client charge/session handlers.
 *
 * Note: buildAndSendTransfer always uses VersionedTransaction, so the
 * `'version' in tx` branch is the only one that fires in practice.
 */
export function keypairWallet(keypair: Keypair) {
  return {
    publicKey: keypair.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if ('version' in tx) {
        (tx as VersionedTransaction).sign([keypair])
      } else {
        (tx as Transaction).sign(keypair)
      }
      return tx
    },
  }
}

export function getTestConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
  return new Connection(url, 'confirmed')
}

export function getTestWallet(): Keypair {
  return Keypair.fromSecretKey(bs58Decode(requireEnv('TEST_WALLET_PRIVATE_KEY')))
}

export function getServerKeypair(): Keypair {
  return Keypair.fromSecretKey(bs58Decode(requireEnv('TEST_SERVER_KEYPAIR')))
}

export function getRecipientAddress(): PublicKey {
  return new PublicKey(requireEnv('TEST_RECIPIENT_ADDRESS'))
}

export function getUsdcMint(): PublicKey {
  return new PublicKey(requireEnv('USDC_DEVNET_MINT'))
}

export function getUsdtMint(): PublicKey {
  return new PublicKey(requireEnv('USDT_DEVNET_MINT'))
}
