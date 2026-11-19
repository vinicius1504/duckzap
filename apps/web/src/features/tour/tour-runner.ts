// Carregado só por import dinâmico (components/product-tour.tsx), quando o tour vai rodar: o driver.js e o CSS
// dele não entram no carregamento das páginas. CSP: o CSS sai como arquivo (<link>), e o driver.js só mexe em
// `element.style` pelo DOM (não é estilo inline bloqueado) e não injeta <script> nem <style>.
import "driver.js/dist/driver.css";
import "./tour.css";
import { driver, type DriveStep } from "driver.js";
import { TOUR_PROGRESS_TEXT, type TourStep } from "./steps";

export type ResolvedTourStep = { step: TourStep; element: Element | null };

/** Roda o tour e devolve como encerrar (troca de página, desmontagem). `onEnd` roda uma vez, por qualquer motivo. */
export function runTour(steps: readonly ResolvedTourStep[], options: { reducedMotion: boolean; onEnd: () => void }): () => void {
  const driveSteps: DriveStep[] = steps.map(({ step, element }, index) => ({
    ...(element ? { element } : {}),
    popover: {
      title: step.title,
      description: step.description,
      // sem "Voltar" no primeiro passo
      showButtons: index === 0 ? ["next", "close"] : ["next", "previous", "close"],
    },
  }));

  const tour = driver({
    steps: driveSteps,
    animate: !options.reducedMotion,
    smoothScroll: !options.reducedMotion,
    overlayColor: "var(--rail)",
    overlayOpacity: 0.6,
    stagePadding: 6,
    stageRadius: 12,
    popoverOffset: 12,
    popoverClass: "dz-tour",
    // o tour só aponta: clicar no item destacado não troca de página no meio da explicação
    disableActiveInteraction: true,
    // clique fora não fecha sem querer; Esc e "Pular tour" fecham
    overlayClickBehavior: "none",
    allowClose: true,
    allowKeyboardControl: true,
    showProgress: steps.length > 1,
    progressText: TOUR_PROGRESS_TEXT,
    nextBtnText: "Próximo",
    prevBtnText: "Voltar",
    doneBtnText: "Concluir",
    closeBtnLabel: "Pular tour",
    onPopoverRender: (popover) => {
      // "Pular tour" escrito (não só um ×) e no rodapé, antes de Voltar/Próximo: ordem de Tab = ordem visual
      popover.closeButton.textContent = "Pular tour";
      popover.footerButtons.prepend(popover.closeButton);
      // leitor de tela ouve título, texto e "2 de 6" ao abrir cada passo
      popover.progress.id = "driver-popover-progress";
      popover.wrapper.setAttribute("aria-describedby", "driver-popover-description driver-popover-progress");
      // o driver foca o primeiro botão (Pular tour); o foco certo é a ação principal
      queueMicrotask(() => popover.nextButton.focus());
    },
    onDestroyed: () => options.onEnd(),
  });

  tour.drive();
  return () => {
    if (tour.isActive()) tour.destroy();
  };
}
