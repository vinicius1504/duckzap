import { Skeleton } from "@duckzap/ui/components/feedback";

export default function ConversationsLoading() {
  return (
    <main aria-busy="true" aria-label="Carregando conversas" className="flex flex-col md:h-[calc(100dvh-4rem)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-6 py-3.5 max-md:px-4">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-10 w-40" />
        <div className="ml-auto flex gap-2 max-lg:hidden">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 w-28" />
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[340px] shrink-0 flex-col gap-3 border-r border-line bg-surface p-4 max-lg:w-[300px] max-md:w-full max-md:border-r-0">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex gap-3 py-1.5">
              <Skeleton className="size-10 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-1 flex-col gap-3 bg-bg p-5 max-md:hidden">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-12 w-2/3 self-start" />
          <Skeleton className="h-12 w-1/2 self-end" />
          <Skeleton className="h-12 w-3/5 self-start" />
          <div className="flex-1" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="hidden w-80 flex-col items-center gap-3 border-l border-line bg-surface p-5 xl:flex">
          <Skeleton className="size-14 rounded-full" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    </main>
  );
}
