// DEMO DATA. Hand-written records in the same JSON shape the live Mouser / DigiKey APIs return, used when
// API keys are not configured. Values come from the bag labels and public datasheet/distributor listings;
// anything we could not confirm is left out so the app shows it as "unknown". Live lookups replace these.

import type { MouserApiPart } from './mouser.ts';
import type { DigikeyApiProduct } from './digikey.ts';

export const MOUSER_FIXTURES: MouserApiPart[] = [
  {
    MouserPartNumber: '771-74LVC244APW-T',
    ManufacturerPartNumber: '74LVC244APW,118',
    Manufacturer: 'Nexperia',
    Description: 'Buffers & Line Drivers 3.3V 8-bit buffer/line driver; 3-state',
    Category: 'Buffers & Line Drivers',
    DataSheetUrl: 'https://assets.nexperia.com/documents/data-sheet/74LVC244A.pdf',
    ProductDetailUrl: 'https://www.mouser.com/ProductDetail/771-74LVC244APW-T',
    ProductAttributes: [
      { AttributeName: 'Product Type', AttributeValue: 'Buffers & Line Drivers' },
      { AttributeName: 'Logic Family', AttributeValue: 'LVC' },
      { AttributeName: 'Number of Channels', AttributeValue: '8 Channel' },
      { AttributeName: 'Output Type', AttributeValue: '3-State' },
      { AttributeName: 'Polarity', AttributeValue: 'Non-Inverting' },
      { AttributeName: 'Supply Voltage - Min', AttributeValue: '1.2 V' },
      { AttributeName: 'Supply Voltage - Max', AttributeValue: '3.6 V' },
      { AttributeName: 'Package / Case', AttributeValue: 'TSSOP-20' },
      { AttributeName: 'Mounting Style', AttributeValue: 'SMD/SMT' },
      { AttributeName: 'Packaging', AttributeValue: 'Reel' },
    ],
  },
  {
    MouserPartNumber: '80-C0805C104J5R',
    ManufacturerPartNumber: 'C0805C104J5RACTU',
    Manufacturer: 'KEMET',
    Description: 'Multilayer Ceramic Capacitors MLCC - SMD/SMT 50V 0.1uF X7R 0805 5%',
    Category: 'Multilayer Ceramic Capacitors MLCC - SMD/SMT',
    ProductDetailUrl: 'https://www.mouser.com/ProductDetail/80-C0805C104J5R',
    ProductAttributes: [
      { AttributeName: 'Capacitance', AttributeValue: '0.1 uF' },
      { AttributeName: 'Voltage Rating DC', AttributeValue: '50 VDC' },
      { AttributeName: 'Dielectric', AttributeValue: 'X7R' },
      { AttributeName: 'Tolerance', AttributeValue: '5 %' },
      { AttributeName: 'Case Code - in', AttributeValue: '0805' },
    ],
  },
  {
    MouserPartNumber: '81-GRM188R71C104KA01',
    ManufacturerPartNumber: 'GRM188R71C104KA01D',
    Manufacturer: 'Murata Electronics',
    Description: 'Multilayer Ceramic Capacitors MLCC - SMD/SMT 0.1uF 16V X7R 10% 0603',
    Category: 'Multilayer Ceramic Capacitors MLCC - SMD/SMT',
    ProductAttributes: [
      { AttributeName: 'Capacitance', AttributeValue: '0.1 uF' },
      { AttributeName: 'Voltage Rating DC', AttributeValue: '16 VDC' },
      { AttributeName: 'Dielectric', AttributeValue: 'X7R' },
      { AttributeName: 'Tolerance', AttributeValue: '10 %' },
      { AttributeName: 'Case Code - in', AttributeValue: '0603' },
    ],
  },
  {
    MouserPartNumber: '81-GRM188F51H104ZA01',
    ManufacturerPartNumber: 'GRM188F51H104ZA01D',
    Manufacturer: 'Murata Electronics',
    Description: 'Multilayer Ceramic Capacitors MLCC - SMD/SMT 0.1uF 50V Y5V -20%/+80% 0603',
    Category: 'Multilayer Ceramic Capacitors MLCC - SMD/SMT',
    ProductAttributes: [
      { AttributeName: 'Capacitance', AttributeValue: '0.1 uF' },
      { AttributeName: 'Voltage Rating DC', AttributeValue: '50 VDC' },
      { AttributeName: 'Dielectric', AttributeValue: 'Y5V' },
      { AttributeName: 'Tolerance', AttributeValue: '-20 %, +80 %' },
      { AttributeName: 'Case Code - in', AttributeValue: '0603' },
    ],
  },
  {
    // YAGEO thin-film resistor, copied from the live Mouser response for this SKU (2026-11-23): the only
    // attributes are Packaging (listed three times) and Standard Pack Qty; the ratings are only in the description.
    MouserPartNumber: '603-RT0603DRD071KL',
    ManufacturerPartNumber: 'RT0603DRD071KL',
    Manufacturer: 'YAGEO',
    Description: 'Thin Film Resistors - SMD 1/10W 1K ohm .5% 25ppm',
    Category: 'Thin Film Resistors - SMD',
    ProductDetailUrl: 'https://www.mouser.com/ProductDetail/603-RT0603DRD071KL',
    ProductAttributes: [
      { AttributeName: 'Packaging', AttributeValue: 'Reel' },
      { AttributeName: 'Packaging', AttributeValue: 'Cut Tape' },
      { AttributeName: 'Packaging', AttributeValue: 'MouseReel' },
      { AttributeName: 'Standard Pack Qty', AttributeValue: '5000' },
    ],
  },
];

export const DIGIKEY_FIXTURES: DigikeyApiProduct[] = [
  {
    // The DigiKey bag photographed for the brief.
    ManufacturerProductNumber: 'B32529C0564J000',
    Manufacturer: { Name: 'EPCOS - TDK Electronics' },
    Description: { ProductDescription: 'CAP FILM 0.56UF 5% 63VDC RADIAL', DetailedDescription: '0.56 µF Film Capacitor 63V Polyester, Metallized Radial' },
    ProductUrl: 'https://www.digikey.com/en/products/result?keywords=495-75588-ND',
    Category: { Name: 'Capacitors', ChildCategories: [{ Name: 'Film Capacitors' }] },
    Parameters: [
      { ParameterText: 'Capacitance', ValueText: '0.56 µF' },
      { ParameterText: 'Tolerance', ValueText: '±5%' },
      { ParameterText: 'Voltage Rating - DC', ValueText: '63V' },
      { ParameterText: 'Dielectric Material', ValueText: 'Polyester, Metallized' },
      { ParameterText: 'Operating Temperature', ValueText: '-55°C ~ 125°C' },
      { ParameterText: 'Mounting Type', ValueText: 'Through Hole' },
      { ParameterText: 'Package / Case', ValueText: 'Radial' },
      { ParameterText: 'Lead Spacing', ValueText: '0.197" (5.00mm)' },
    ],
    ProductVariations: [{ DigiKeyProductNumber: '495-75588-ND', PackageType: { Name: 'Bulk' } }],
  },
  {
    // The DigiKey row from the brief's table (online photo = demo data). Specs intentionally empty:
    // we could not confirm them offline, so the app shows them as unknown until a live lookup.
    ManufacturerProductNumber: '0387236506',
    Manufacturer: { Name: 'Molex' },
    Description: { ProductDescription: 'Molex connector (demo record, specs not loaded)' },
    ProductUrl: 'https://www.digikey.com/en/products/result?keywords=WM20054-ND',
    Category: { Name: 'Connectors, Interconnects' },
    Parameters: [],
    ProductVariations: [{ DigiKeyProductNumber: 'WM20054-ND' }],
  },
];
