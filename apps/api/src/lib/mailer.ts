import { createTransport } from "nodemailer";
import type { Env } from "../env";

export type Mail = { to: string; subject: string; text: string };

/** Em dev o SMTP é o Mailpit (http://localhost:8026). Em produção, Resend/SES (§2). */
export function createMailer(env: Env) {
  const transport = createTransport({
    url: env.SMTP_URL,
    // SMTP fora do ar não pode prender a requisição (nem o convite) por minutos
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return async (mail: Mail) => {
    await transport.sendMail({ from: env.MAIL_FROM, ...mail });
  };
}

export type Mailer = ReturnType<typeof createMailer>;
