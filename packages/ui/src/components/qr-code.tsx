import { encode } from "uqr";
import { cn } from "../lib/cn";

/**
 * QR Code REAL (legível por câmera), desenhado em SVG a partir do texto.
 * Sempre escuro sobre fundo branco com margem ("quiet zone"), em qualquer tema: a câmera exige esse contraste.
 * Usado no QR do WhatsApp (conectar canal) e no do app autenticador (2FA).
 */
export function QrCode({
  value,
  label,
  size = 200,
  faded = false,
  className,
}: {
  value: string;
  label: string;
  size?: number;
  /** Código vencido: mantém o desenho, mas apagado, para ninguém tentar ler. */
  faded?: boolean;
  className?: string;
}) {
  // correção de erro "M": equilibra tamanho e tolerância a reflexo; 2 módulos de margem
  const { data, size: modules } = encode(value, { ecc: "M", border: 2 });
  let path = "";
  for (let y = 0; y < modules; y++) {
    let x = 0;
    while (x < modules) {
      if (data[y]?.[x]) {
        const start = x;
        while (x < modules && data[y]?.[x]) x++;
        path += `M${start} ${y}h${x - start}v1h-${x - start}z`;
      } else {
        x++;
      }
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={cn("shrink-0 rounded-xl border border-line bg-white", faded && "opacity-20", className)}
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
