// Recorded from the original Mouser bag photo (test/photos/mouser-74lvc244.jpg, 1215x1620) in the app's
// real scan flow. OCR on this photo garbles both part numbers; the barcodes decode cleanly.

import type { BarcodeHit, OcrLine } from '../../src/shared/types.ts';

/** Raw Tesseract text the parser received (scan flow, prepared grayscale image). */
export const MOUSER_PHOTO_OCR = `J = a EE
y STV /
J | 2 HE HO SIRIRY. oops ag Foti A \\ |
5] VHA Eh Tx
| & Line Itap: 015 En | ae es |
| ETT 5
y Mouser P/N: 971 04) yeoaanpy : RE }
| a
: | MFG P/N: 741YC2q4ppPu, 118 sr. uh EC
| I ORB SERA . 5
| Desc: SOT3680-1 BUFFERS & L 3% Y =
| Nexperia Buffers & Lise Driverc —— 1
| RoHS: compliant oN f—— | J
ry: 12 0: (| Lo
ili iii =
Loice No: 057258759 PE —
`;

/** A second OCR run on the same photo (raw colour image) — different garbage, same problem. */
export const MOUSER_PHOTO_OCR_RUN2 = `E Line Itan: 015 IG% PH) ass i
Mouser py: 771-241 YLR44APY-T LY \\
I EE OO 0 " = |
/ MFG P/N: 74 ycaqanpy, 118 ’ .
f Desc: SOT360-1 BUFFERS & L - =
| Nexperia Buffers & Lime Driuverc Ee —
| RoHS: compliant or r— !
“5 C00: CN —
pice No.: 087258759 a |
`;

/** OCR line boxes from that run (the barcode bars themselves are sometimes read as a "text" line). */
export const MOUSER_PHOTO_LINES: OcrLine[] = [
  { text: 'E Line Itan: 015 IG% PH) ass i', x0: 209, y0: 746, x1: 760, y1: 781 },
  { text: 'A TTT 4 \\', x0: 169, y0: 761, x1: 720, y1: 827 },
  { text: 'Mouser py: 771-241 YLR44APY-T LY \\', x0: 280, y0: 820, x1: 790, y1: 876 },
  { text: 'I EE OO 0 " = |', x0: 277, y0: 842, x1: 760, y1: 910 },
  { text: '/ MFG P/N: 74 ycaqanpy, 118 ’ .', x0: 158, y0: 892, x1: 934, y1: 938 },
  { text: 'I AOR ERO A " =', x0: 273, y0: 918, x1: 720, y1: 985 },
  { text: 'f Desc: SOT360-1 BUFFERS & L - =', x0: 152, y0: 968, x1: 874, y1: 994 },
  { text: '“5 C00: CN —', x0: 288, y0: 1067, x1: 640, y1: 1108 },
  { text: 'pice No.: 087258759 a |', x0: 269, y0: 1304, x1: 600, y1: 1366 },
];

/** Barcodes the in-browser reader decoded, with their boxes. */
export const MOUSER_PHOTO_BARCODES: BarcodeHit[] = [
  { text: '771-74LVC244APW-T', format: 'linear', x0: 269, y0: 842, x1: 761, y1: 897 },
  { text: '74LVC244APW,118', format: 'linear', x0: 261, y0: 917, x1: 715, y1: 966 },
  { text: '087258759', format: 'linear', x0: 241, y0: 1326, x1: 565, y1: 1385 },
  { text: '015', format: 'linear', x0: 271, y0: 765, x1: 446, y1: 810 },
  { text: '12', format: 'linear', x0: 253, y0: 1091, x1: 403, y1: 1132 },
  { text: 'CN', format: 'linear', x0: 490, y0: 1089, x1: 634, y1: 1130 },
];
