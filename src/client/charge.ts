import { Method, Credential } from 'mppx'
import { Connection, PublicKey } from '@solana/web3.js'
import { charge as chargeMethod } from '../methods/charge.js'
import { resolvePool, type SolanaNetwork, type PriorityFee } from '../core/rpc.js'
import { parseAmount } from '../core/utils.js'
import { buildAndSendTransfer } from '../core/transaction.js'
import type { WalletLike } from '../types.js'

export namespace charge {
  export interface Parameters {
    wallet: WalletLike | (() => WalletLike | Promise<WalletLike>)
    mint?: PublicKey
    connection?: Connection
    endpoints?: string[]
    network?: SolanaNetwork
    priorityFee?: PriorityFee
  }
}

export function charge(params: charge.Parameters) {
  const { network = 'mainnet-beta', priorityFee } = params
  const pool = resolvePool({ connection: params.connection, endpoints: params.endpoints, network })

  let walletPromise: Promise<WalletLike> | undefined
  function getWallet(): Promise<WalletLike> {
    if (!walletPromise) {
      const w = params.wallet
      walletPromise = Promise.resolve(typeof w === 'function' ? w() : w)
    }
    return walletPromise
  }

  return Method.toClient(chargeMethod, {
    async createCredential({ challenge }) {
      if (params.mint && challenge.request.methodDetails.mint !== params.mint.toBase58()) {
        throw new Error(`Mint mismatch: expected ${params.mint.toBase58()}, got ${challenge.request.methodDetails.mint}`)
      }
      const wallet = await getWallet()
      const { amount, methodDetails } = challenge.request
      const signature = await pool.withConnection(async (connection) =>
        buildAndSendTransfer({
          connection, wallet,
          mint: new PublicKey(methodDetails.mint),
          recipient: new PublicKey(methodDetails.recipient),
          amount: parseAmount(amount, methodDetails.decimals),
          decimals: methodDetails.decimals,
          reference: new PublicKey(methodDetails.reference),
          priorityFee,
        })
      )
      return Credential.serialize({ challenge, payload: { signature } })
    },
  })
}
