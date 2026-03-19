import { Method, z } from 'mppx'

export const charge = Method.from({
  name: 'solana',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.object({
        signature: z.string(),
      }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.optional(z.string()),
      description: z.optional(z.string()),
      methodDetails: z.object({
        recipient: z.string(),
        mint: z.string(),
        decimals: z.number(),
        reference: z.string(),
        network: z.optional(z.string()),
      }),
    }),
  },
})
