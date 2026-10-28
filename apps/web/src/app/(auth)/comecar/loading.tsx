import { Skeleton } from "@duckzap/ui/components/feedback";

export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg" aria-busy="true">
      <span className="sr-only">Carregando</span>
      <div className="flex items-center justify-between gap-4 border-b border-line bg-surface px-10 py-5 max-md:px-4">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-7 w-[min(360px,50%)]" />
      </div>
      <div className="mx-auto flex w-[min(960px,100%)] flex-col gap-6 px-6 py-10 max-sm:px-4">
        <Skeleton className="h-9 w-[min(420px,100%)]" />
        <Skeleton className="h-5 w-[min(320px,100%)]" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    </div>
  );
}
