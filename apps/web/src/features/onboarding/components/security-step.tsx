"use client";

import type { OnboardingSecurity } from "@duckzap/contracts/onboarding";
import type { TwoFactorMethod } from "@duckzap/contracts/settings";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { pageTitleClass } from "@duckzap/ui/components/layout";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { skipSecurityStepAction } from "@/features/security/actions";
import { MethodOptions, RecoveryCodesView, TwoFactorSetupFlow } from "@/features/security/components/two-factor-setup";
import { methodLabels, methodSignInHint } from "@/features/security/rules";

const NEXT = "/comecar?passo=empresa";

/**
 * Passo OPCIONAL "Proteja sua conta", logo depois de criar a conta e antes da empresa. Ativar (app recomendado, ou código
 * por e-mail) ou "Pular por enquanto" ficam gravados no banco: recarregar no meio só recomeça a configuração do 2FA.
 */
export function SecurityStep({ security }: { security: OnboardingSecurity }) {
  const router = useRouter();
  const [method, setMethod] = useState<TwoFactorMethod>("app");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function skip() {
    setError(null);
    startTransition(async () => {
      const result = await skipSecurityStepAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(NEXT);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className={pageTitleClass}>Proteja sua conta</h1>
        <p className="mt-1.5 text-ink-2">
          Além da senha, pedimos um código na hora de entrar. Assim ninguém abre suas conversas e clientes, mesmo que descubra a
          sua senha.
        </p>
      </div>

      {error ? (
        <Alert tone="err" live>
          {error}
        </Alert>
      ) : null}

      <Card padding="lg" className="flex flex-col gap-5">
        {codes ? (
          <RecoveryCodesView codes={codes} title="Conta protegida!" doneLabel="Já guardei, continuar" onDone={() => router.push(NEXT)} />
        ) : security.twoFactorEnabled ? (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 font-bold">
              <Icon name="shield" size={20} /> Sua conta já está protegida
              {security.method ? ` (${methodLabels[security.method].toLowerCase()})` : ""}.
            </p>
            {security.method ? <p className="text-ink-2">{methodSignInHint[security.method]}</p> : null}
            <p className="text-[13px] text-ink-2">Para trocar de método ou gerar novos códigos de recuperação, use Ajustes › Minha conta.</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-start gap-8">
            <div className="min-w-0 flex-[1_1_300px]">
              <MethodOptions value={method} onChange={setMethod} />
            </div>
            <div className="min-w-0 flex-[1_1_320px]">
              <TwoFactorSetupFlow
                key={method}
                method={method}
                passwordLabel="Sua senha"
                passwordHint="A mesma que você acabou de criar. Pedimos de novo para confirmar que é você."
                onEnabled={(recoveryCodes) => (recoveryCodes ? setCodes(recoveryCodes) : router.push(NEXT))}
              />
            </div>
          </div>
        )}
      </Card>

      {codes ? null : (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {security.twoFactorEnabled ? (
            <Button size="lg" variant="primary" onClick={() => router.push(NEXT)}>
              Continuar
            </Button>
          ) : (
            <>
              <Button size="lg" onClick={skip} disabled={pending}>
                {pending ? <Spinner size={16} /> : null}
                Pular por enquanto
              </Button>
              <p className="w-full text-right text-[13px] text-ink-2">Dá para ativar depois em Ajustes › Minha conta.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
