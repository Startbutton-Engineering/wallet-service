import z from "zod";

/** back-end merchant ids are ObjectIds; the legacy `wallets` documents are keyed by them. */
const merchantId = z.string().regex(/^[a-f0-9]{24}$/i, 'ownerId must be a back-end merchant id (24 hex characters)');

export const cutoverSchema = z.object({ ownerId: merchantId });
export type CutoverDto = z.infer<typeof cutoverSchema>;
