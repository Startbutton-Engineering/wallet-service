import z from "zod";

export const registerCurrencySchema = z.object({
  code: z.string().min(1),
  scale: z.number().int().min(0).max(30),
  type: z.enum(['fiat', 'crypto'])
})
export type RegisterCurrencyDto = z.infer<typeof registerCurrencySchema>