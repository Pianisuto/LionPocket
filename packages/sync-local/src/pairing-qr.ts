import qrcode = require('qrcode-generator');
/** Entirely local QR generation; the capability is never sent to a rendering service. */
export function pairingQr(link: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size + 8 }, (_, y) =>
    Array.from(
      { length: size + 8 },
      (_, x) =>
        x >= 4 &&
        y >= 4 &&
        x < size + 4 &&
        y < size + 4 &&
        qr.isDark(y - 4, x - 4),
    ),
  );
}
