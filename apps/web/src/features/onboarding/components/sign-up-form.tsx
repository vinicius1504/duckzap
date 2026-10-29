"use client";

import { signUpSchema, type SignUpInput } from "@duckzap/contracts/onboarding";
import { Button } from "@duckzap/ui/components/button";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { signUpAction } from "../actions";

/** A confirmação só existe na tela: o servidor recebe o mesmo `SignUpInput` de sempre. */
const signUpFormSchema = signUpSchema
  .extend({ confirmPassword: z.string() })
  .refine((values) => values.password === values.confirmPassword, { error: "As senhas não conferem.", path: ["confirmPassword"] });
type SignUpFormValues = z.infer<typeof signUpFormSchema>;

export function SignUpForm() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpFormValues>({
    resolver: zodResolver(signUpFormSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "", acceptTerms: false },
  });

  async function onSubmit({ confirmPassword: _confirm, ...values }: SignUpFormValues) {
    setServerError(null);
    const input: SignUpInput = values;
    const result = await signUpAction(input);
    if (result) {
      setServerError(result.error);
      return;
    }
    router.replace("/comecar?passo=empresa");
    router.refresh();
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      {serverError ? (
        <Alert tone="err" live className="font-semibold">
          {serverError}
        </Alert>
      ) : null}

      <div>
        <Label htmlFor="nome">Seu nome</Label>
        <Input
          id="nome"
          autoComplete="name"
          placeholder="Marina Alves"
          invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "nome-erro" : undefined}
          {...register("name")}
        />
        <FieldError id="nome-erro" message={errors.name?.message} />
      </div>

      <div>
        <Label htmlFor="email">E-mail</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="voce@empresa.com.br"
          invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? "email-erro" : undefined}
          {...register("email")}
        />
        <FieldError id="email-erro" message={errors.email?.message} />
      </div>

      <div>
        <Label htmlFor="senha">Senha</Label>
        <div className="relative">
          <Input
            id="senha"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            className="pr-12"
            invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? "senha-dica senha-erro" : "senha-dica"}
            {...register("password")}
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
            aria-pressed={showPassword}
            className="absolute right-1 top-1 flex size-9 items-center justify-center rounded-lg text-ink-2"
          >
            <Icon name={showPassword ? "eyeOff" : "eye"} />
          </button>
        </div>
        <p id="senha-dica" className="mt-1.5 text-xs text-ink-2">
          Pelo menos 8 caracteres, com letras e números.
        </p>
        <FieldError id="senha-erro" message={errors.password?.message} />
      </div>

      <div>
        <Label htmlFor="senha-confirma">Repita a senha</Label>
        <Input
          id="senha-confirma"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          invalid={Boolean(errors.confirmPassword)}
          aria-describedby={errors.confirmPassword ? "senha-confirma-erro" : undefined}
          {...register("confirmPassword")}
        />
        <FieldError id="senha-confirma-erro" message={errors.confirmPassword?.message} />
      </div>

      <div>
        <label className="flex min-h-11 items-start gap-2.5 text-[13px]">
          <Checkbox
            className="mt-0.5"
            aria-invalid={Boolean(errors.acceptTerms) || undefined}
            aria-describedby={errors.acceptTerms ? "termos-erro" : undefined}
            {...register("acceptTerms")}
          />
          <span>
            Li e aceito os{" "}
            <Link href="/termos" target="_blank" className="font-bold underline">
              Termos de uso
            </Link>{" "}
            e a{" "}
            <Link href="/privacidade" target="_blank" className="font-bold underline">
              Política de privacidade
            </Link>
            .
          </span>
        </label>
        <FieldError id="termos-erro" message={errors.acceptTerms?.message} />
      </div>

      <Button type="submit" variant="primary" size="lg" disabled={isSubmitting} className="w-full">
        {isSubmitting ? (
          <>
            <Spinner /> Criando conta…
          </>
        ) : (
          "Criar conta grátis"
        )}
      </Button>
    </form>
  );
}
