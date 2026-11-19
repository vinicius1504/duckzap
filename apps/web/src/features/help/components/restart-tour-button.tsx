import { buttonVariants } from "@duckzap/ui/components/button";
import Link from "next/link";
import { TOUR_HOME_PATH, TOUR_QUERY } from "@/features/tour/steps";

/** Leva ao Início com `?tour=1`: o tour roda de novo mesmo já visto (o estado do tour é do navegador). */
export function RestartTourButton() {
  return (
    <Link href={`${TOUR_HOME_PATH}?${TOUR_QUERY}=1`} className={buttonVariants({ size: "lg" })}>
      Fazer o tour de novo
    </Link>
  );
}
