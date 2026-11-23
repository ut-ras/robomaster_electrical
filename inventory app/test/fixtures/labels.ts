// Transcriptions of the two bag photos supplied with the brief, written the way Tesseract tends to
// return them (line order, some noise). They stand in for the photos in automated tests; the photos
// themselves are exercised in the browser (see README "Photo check").

/** Mouser bag: 771-74LVC244APW-T / Nexperia 74LVC244APW,118 / QTY 12 (photo supplied by the team). */
export const MOUSER_74LVC244_OCR = `
M MOUSER
ELECTRONICS www.mouser.com
Cust PO: SIRIOY 382M LAB
Line Itcm: 015
Mouser P/N: 771-74LVC244APW-T
MFG P/N: 74LVC244APW,118
Desc: SOT360-1 BUFFERS & L
Nexperia Buffers & Line Drivers
RoHS: compliant
QTY: 12 COO: CN
Invoice No.: 087258759
IR
`;

/** Same label with typical OCR damage: O for 0 in the prefix, '.' for ',' in the MPN. */
export const MOUSER_74LVC244_OCR_NOISY = MOUSER_74LVC244_OCR
  .replace('771-74LVC244APW-T', '77l-74LVC244APW-T')
  .replace('74LVC244APW,118', '74LVC244APW.118');

/** Code 128 values printed under each Mouser field (what a barcode reader returns). */
export const MOUSER_74LVC244_BARCODES = ['SIRIUS 382M LAB', '015', '771-74LVC244APW-T', '74LVC244APW,118', '12', 'CN', '087258759'];

/** DigiKey bag in the photo attached to the brief: 495-75588-ND / TDK B32529C0564J000 / Quantity 10. */
export const DIGIKEY_TDK_OCR = `
INV#107611016
SO#89049089 IDX: 19
PO#
DigiKey
701 Brooks Ave South, Thief River Falls, MN 56701 USA
PN 495-75588-ND
B32529C0564J000
CAP FILM 0.56UF 5% 63VDC RADIAL
CUST SX-968
2135 0640274963
COO BR
RoHS3 COMP
MSL N/A
07-OCT-2024 16:21 MID 3490476
007382757
TDK ELECTRONICS INC
Quantity
10
`;

/** DigiKey demo label from the table in the brief (online photo; treated as demo data). */
export const DIGIKEY_MOLEX_OCR = `
DigiKey
701 Brooks Ave South, Thief River Falls, MN 56701 USA
PN WM20054-ND
0387236506
CONN HOUSING
MOLEX
Quantity 2
`;

/** ECIA DataMatrix payload as printed on DigiKey labels ( GS = \\x1d, RS = \\x1e ). */
export const DIGIKEY_MOLEX_DATAMATRIX = '[)>\x1e06\x1dPWM20054-ND\x1d1P0387236506\x1d30PWM20054-ND\x1dK\x1d1K00000000\x1d10K000000\x1d11K1\x1d4LUS\x1dQ2\x1d11ZPICK\x1e\x04';
