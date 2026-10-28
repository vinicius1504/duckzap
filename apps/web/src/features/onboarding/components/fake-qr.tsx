import { QrCode } from "@duckzap/ui/components/qr-code";

/** QR REAL do WhatsApp no cadastro. `faded` apaga o código vencido. */
export function FakeQr({ payload, size = 190, faded = false }: { payload: string; size?: number; faded?: boolean }) {
  return <QrCode value={payload} label="QR Code para conectar o WhatsApp" size={size} faded={faded} />;
}
