import { QrCode } from "@duckzap/ui/components/qr-code";

/** Mantém o nome antigo dos imports; agora desenha um QR REAL (legível) a partir do conteúdo. */
export function FakeQr({ payload, label, size = 200 }: { payload: string; label: string; size?: number }) {
  return <QrCode value={payload} label={label} size={size} />;
}
