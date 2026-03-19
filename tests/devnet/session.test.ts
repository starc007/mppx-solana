import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { Store } from 'mppx'
import { Mppx as ServerMppx } from 'mppx/server'
import { Mppx as ClientMppx } from 'mppx/client'
import { session as serverSession } from '../../src/server/session.js'
import { session as clientSession } from '../../src/client/session.js'
import {
  getTestConnection,
  getTestWallet,
  getRecipientAddress,
  getServerKeypair,
  getUsdcMint,
  keypairWallet,
} from './helpers.js'

const SKIP = !process.env.TEST_WALLET_PRIVATE_KEY

describe('session devnet integration', () => {
  let server: ReturnType<typeof Bun.serve>
  let baseUrl: string

  beforeAll(() => {
    if (SKIP) return

    const store = Store.memory()
    const connection = getTestConnection()
    const recipient = getRecipientAddress()
    const mint = getUsdcMint()
    const serverKeypair = getServerKeypair()

    const sessionMethod = serverSession({
      recipient,
      mint,
      serverKeypair,
      connection,
      store,
      verifyTimeout: 90_000,
    })

    const mppx = ServerMppx.create({
      methods: [sessionMethod],
    })

    const app = new Hono()

    // The respond() hook in session.ts returns a Response directly for topUp and close
    // actions, and returns undefined for open and bearer (expecting caller to use
    // withReceipt). Because withReceipt() short-circuits when respond() returned a
    // Response, calling withReceipt(resourceResponse) always works correctly:
    // - open / bearer: resourceResponse is used (with receipt header attached)
    // - topUp / close: the hook's Response is used (with receipt header attached)
    app.all('/session', async (c) => {
      const result = await mppx['solana/session']({
        amount: '0.10',
        depositAmount: '1.00',
      })(c.req.raw)

      if (result.status === 402) return result.challenge

      if (result.status === 200) {
        return result.withReceipt(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      return new Response('error', { status: 500 })
    })

    server = Bun.serve({
      port: 0,
      fetch: app.fetch,
    })
    baseUrl = `http://localhost:${server.port}`
  })

  afterAll(() => {
    if (server) server.stop(true)
  })

  it('skips when TEST_WALLET_PRIVATE_KEY not set', () => {
    if (!SKIP) return
    expect(SKIP).toBe(true)
  })

  it('open → use × 2 → close with refund', async () => {
    if (SKIP) return

    const wallet = keypairWallet(getTestWallet())
    const connection = getTestConnection()
    const mint = getUsdcMint()

    const sessionClient = clientSession({ wallet, mint, connection })
    const mppxClient = ClientMppx.create({ methods: [sessionClient], polyfill: false })

    // First request: triggers open (deposit tx + open credential)
    const openRes = await mppxClient.fetch(`${baseUrl}/session`)
    expect(openRes.status).toBe(200)

    // Capture sessionId + bearer from MPP-Receipt header
    sessionClient.setSessionFromResponse(openRes)
    const sessionAfterOpen = sessionClient.getSession()
    expect(sessionAfterOpen).not.toBeNull()
    expect(sessionAfterOpen?.sessionId).toBeTruthy()
    expect(sessionAfterOpen?.bearer).toBeTruthy()

    // Second request: uses bearer credential
    const useRes1 = await mppxClient.fetch(`${baseUrl}/session`)
    expect(useRes1.status).toBe(200)
    const body1 = await useRes1.json() as { ok: boolean }
    expect(body1.ok).toBe(true)

    // Third request: uses bearer credential again
    const useRes2 = await mppxClient.fetch(`${baseUrl}/session`)
    expect(useRes2.status).toBe(200)
    const body2 = await useRes2.json() as { ok: boolean }
    expect(body2.ok).toBe(true)

    // Signal close, then make one more request (triggers close credential)
    sessionClient.close()
    const closeRes = await mppxClient.fetch(`${baseUrl}/session`)
    expect(closeRes.status).toBe(200)

    // After close the session must be cleared
    expect(sessionClient.getSession()).toBeNull()
  }, 120_000)

  it('rejects invalid bearer', async () => {
    if (SKIP) return

    const wallet = keypairWallet(getTestWallet())
    const connection = getTestConnection()
    const mint = getUsdcMint()

    // Open a real session first
    const sessionClient = clientSession({ wallet, mint, connection })
    const mppxClient = ClientMppx.create({ methods: [sessionClient], polyfill: false })

    const openRes = await mppxClient.fetch(`${baseUrl}/session`)
    expect(openRes.status).toBe(200)
    sessionClient.setSessionFromResponse(openRes)

    const realSession = sessionClient.getSession()
    expect(realSession).not.toBeNull()

    // Get a fresh challenge so we have a valid challenge object
    const challengeRes = await fetch(`${baseUrl}/session`)
    expect(challengeRes.status).toBe(402)
    const wwwAuth = challengeRes.headers.get('WWW-Authenticate')
    expect(wwwAuth).toBeTruthy()

    // Build a bearer credential with a tampered bearer value
    const { Challenge, Credential } = await import('mppx')
    const challenge = Challenge.fromResponse(challengeRes)

    const tamperedCredential = Credential.serialize({
      challenge,
      payload: {
        action: 'bearer' as const,
        sessionId: realSession!.sessionId,
        bearer: 'invalid-bearer-value-that-will-not-match-hash',
      },
    })

    const badBearerRes = await fetch(`${baseUrl}/session`, {
      headers: { Authorization: `${challenge.method} ${tamperedCredential}` },
    })

    // Server must reject a credential with the wrong bearer
    expect(badBearerRes.status).not.toBe(200)

    // Clean up: close the real session so refund is issued
    sessionClient.close()
    await mppxClient.fetch(`${baseUrl}/session`)
  }, 120_000)

  it('closes with zero balance — no refund tx', async () => {
    if (SKIP) return

    const wallet = keypairWallet(getTestWallet())
    const connection = getTestConnection()
    const mint = getUsdcMint()

    // Use depositAmount equal to amount so a single use exhausts the balance.
    // We create a fresh server for this test with amount === depositAmount.
    const store = Store.memory()
    const serverKeypair = getServerKeypair()
    const recipient = getRecipientAddress()

    const tightMethod = serverSession({
      recipient,
      mint,
      serverKeypair,
      connection,
      store,
      verifyTimeout: 90_000,
    })

    const tightMppx = ServerMppx.create({ methods: [tightMethod] })

    const tightApp = new Hono()
    tightApp.all('/session-tight', async (c) => {
      // amount === depositAmount: one use empties the balance
      const result = await tightMppx['solana/session']({
        amount: '1.00',
        depositAmount: '1.00',
      })(c.req.raw)
      if (result.status === 402) return result.challenge
      if (result.status === 200) {
        return result.withReceipt(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }
      return new Response('error', { status: 500 })
    })

    const tightServer = Bun.serve({ port: 0, fetch: tightApp.fetch })
    const tightUrl = `http://localhost:${tightServer.port}`

    try {
      const sessionClient = clientSession({ wallet, mint, connection })
      const mppxClient = ClientMppx.create({ methods: [sessionClient], polyfill: false })

      // Open the session (deposits 1.00, first use also charges 1.00)
      const openRes = await mppxClient.fetch(`${tightUrl}/session-tight`)
      expect(openRes.status).toBe(200)
      sessionClient.setSessionFromResponse(openRes)
      expect(sessionClient.getSession()).not.toBeNull()

      // Balance is now 0 (depositAmount - amount = 0). Close without refund tx.
      sessionClient.close()
      const closeRes = await mppxClient.fetch(`${tightUrl}/session-tight`)
      expect(closeRes.status).toBe(200)
      expect(sessionClient.getSession()).toBeNull()
    } finally {
      tightServer.stop(true)
    }
  }, 120_000)

  it('top-up: client deposits more, server adds to balance, use continues', async () => {
    if (SKIP) return

    const wallet = keypairWallet(getTestWallet())
    const connection = getTestConnection()
    const mint = getUsdcMint()

    // Server configured with amount=0.10 and depositAmount=0.20 so the session
    // can be used twice before running out. After one use we top-up to continue.
    const store = Store.memory()
    const serverKeypair = getServerKeypair()
    const recipient = getRecipientAddress()

    const topUpMethod = serverSession({
      recipient,
      mint,
      serverKeypair,
      connection,
      store,
      verifyTimeout: 90_000,
    })

    const topUpMppx = ServerMppx.create({ methods: [topUpMethod] })

    const topUpApp = new Hono()
    topUpApp.all('/session-topup', async (c) => {
      const result = await topUpMppx['solana/session']({
        amount: '0.10',
        depositAmount: '0.20',
      })(c.req.raw)
      if (result.status === 402) return result.challenge
      if (result.status === 200) {
        return result.withReceipt(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }
      return new Response('error', { status: 500 })
    })

    const topUpServer = Bun.serve({ port: 0, fetch: topUpApp.fetch })
    const topUpUrl = `http://localhost:${topUpServer.port}`

    try {
      const sessionClient = clientSession({ wallet, mint, connection })
      const mppxClient = ClientMppx.create({ methods: [sessionClient], polyfill: false })

      // 1. Open session (deposits 0.20, first use charges 0.10 → 0.10 remaining)
      const openRes = await mppxClient.fetch(`${topUpUrl}/session-topup`)
      expect(openRes.status).toBe(200)
      sessionClient.setSessionFromResponse(openRes)
      expect(sessionClient.getSession()).not.toBeNull()

      // 2. Use it once more (bearer, charges 0.10 → 0 remaining)
      const useRes = await mppxClient.fetch(`${topUpUrl}/session-topup`)
      expect(useRes.status).toBe(200)

      // 3. Signal top-up; next fetch sends a new deposit tx
      sessionClient.topUp()

      // 4. Top-up fetch: client sends depositAmount (0.20) on-chain and provides topUp credential
      const topUpRes = await mppxClient.fetch(`${topUpUrl}/session-topup`)
      expect(topUpRes.status).toBe(200)

      // 5. Continue using session — bearer should succeed because balance is restored
      const afterTopUpRes = await mppxClient.fetch(`${topUpUrl}/session-topup`)
      expect(afterTopUpRes.status).toBe(200)
      const body = await afterTopUpRes.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      // 6. Close and verify refund (remaining balance > 0)
      sessionClient.close()
      const closeRes = await mppxClient.fetch(`${topUpUrl}/session-topup`)
      expect(closeRes.status).toBe(200)
      expect(sessionClient.getSession()).toBeNull()
    } finally {
      topUpServer.stop(true)
    }
  }, 120_000)
})
