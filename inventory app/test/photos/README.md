Put bag photos here to repeat the manual photo check in the project README.

The original Mouser and DigiKey bag photos are deliberately **not shipped** with this project:
they show purchase-order and invoice numbers. The automated regression test does not need them —
`../photo-scan.test.ts` replays the OCR text and barcode positions recorded from the Mouser photo
(see `../fixtures/mouser-photo.ts`).

The server serves this folder only when `SERVE_TEST_PHOTOS=1` is set in `.env`. Keep that local.
