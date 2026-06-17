// Auth — shared Zod schemas. Lenient on email shape (existing accounts predate
// any strict format rule); just normalise case + require non-empty.
import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().min(1, "Email is required").transform((s) => s.toLowerCase()),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;
