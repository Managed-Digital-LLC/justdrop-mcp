import qrcode from "qrcode-terminal";

/** Renders a compact unicode QR code as a string (never touches stdout — that's the MCP channel). */
export function qrString(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (qr) => resolve(qr));
  });
}
