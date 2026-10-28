import { z } from "zod";

export const signInSchema = z.object({
  email: z.email({ error: "Informe um e-mail válido." }).trim().toLowerCase(),
  password: z.string().min(1, { error: "Informe sua senha." }).max(128),
  rememberMe: z.boolean(),
});

export type SignInInput = z.infer<typeof signInSchema>;
