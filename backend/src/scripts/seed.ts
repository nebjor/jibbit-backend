/**
 * Seed für jibbit.ch — Schweizer Headshop.
 *
 * Ersetzt den Medusa-Demo-Seed (Europe/EUR, Kopenhagen, Medusa-T-Shirts).
 *
 * WICHTIG — Einheiten:
 * Medusa v2 speichert Beträge als DEZIMALZAHLEN, nicht in Rappen.
 * CHF 27.00 === 27. Alle `amount`-Werte hier sind Franken, keine Rappen.
 *
 * Provider-IDs (verifiziert gegen die DB nach `medusa db:migrate`):
 *   payment_provider      → pp_system_default,
 *                           pp_zahls_zahls (nur bei gesetzter ZAHLS_*-Env,
 *                           siehe Kommentar an der Region unten)
 *   fulfillment_provider  → swiss-shipping_swiss-shipping
 * `manual_manual` existiert in diesem Projekt NICHT — medusa-config.ts
 * registriert ausschliesslich den swiss-shipping Provider.
 *
 * Der Seed ist so weit wie möglich idempotent (Region, Lager, Steuerregion,
 * Fulfillment-Set, Kategorien und Produkte werden vor dem Anlegen geprüft),
 * damit er beim Iterieren nicht in Unique-Constraint-Fehler läuft.
 */

import { CreateInventoryLevelInput, ExecArgs } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductCategoriesWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows";

import {
  isZahlsPluginConfigured,
  ZAHLS_PROVIDER_ID,
} from "../lib/zahls-plugin";

// Der Stock-Seed importierte `ApiKey` aus ../../.medusa/types/query-entry-points.
// Diese Datei wird generiert und existiert vor dem ersten Build nicht — der
// Import bricht `medusa exec` und den Typecheck. Hier wird ohnehin nur die ID
// gebraucht.
type SeedApiKey = { id: string };

// ─── Konstanten ────────────────────────────────────────────────
const CURRENCY = "chf";
const COUNTRY = "ch";
const SALES_CHANNEL_NAME = "Default Sales Channel";
const REGION_NAME = "Schweiz";
const STOCK_LOCATION_NAME = "Lager Zürich";
const FULFILLMENT_SET_NAME = "Versand Schweiz";
const FULFILLMENT_PROVIDER_ID = "swiss-shipping_swiss-shipping";

/**
 * CHF — Dezimalbeträge, nicht Rappen.
 * NUR für Beschriftungen. Die tatsächliche Berechnung macht
 * SwissShippingProviderService.calculatePrice() mit den Werten aus
 * medusa-config.ts (letterPrice / parcelPrice / freeShippingThreshold) — beide Stellen
 * müssen synchron gehalten werden.
 */
const SHIPPING_LETTER_PRICE = 3.75;
const SHIPPING_PARCEL_PRICE = 9;
const FREE_SHIPPING_THRESHOLD = 69;

/** Schweizer MwSt.-Normalsatz seit 01.01.2024. */
const CH_VAT_RATE = 8.1;

// Der Stock-Seed definierte hier einen eigenen "update-store-currencies"
// Workflow, der nur `updateStoresStep` aufruft. Das reicht hier NICHT:
// `is_tax_inclusive` wird nicht am Store gespeichert, sondern von
// `updateStoresWorkflow` als `price_preference` (attribute=currency_code)
// upgesertet. Deshalb wird direkt der Core-Workflow verwendet.

export default async function seedJibbitData({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const fulfillmentModuleService = container.resolve(Modules.FULFILLMENT);
  const salesChannelModuleService = container.resolve(Modules.SALES_CHANNEL);
  const storeModuleService = container.resolve(Modules.STORE);
  const regionModuleService = container.resolve(Modules.REGION);
  const stockLocationModuleService = container.resolve(Modules.STOCK_LOCATION);
  const taxModuleService = container.resolve(Modules.TAX);

  // ─── Store + Sales Channel ───────────────────────────────────
  logger.info("Seeding store data (CHF)...");
  const [store] = await storeModuleService.listStores();

  let defaultSalesChannel = await salesChannelModuleService.listSalesChannels({
    name: SALES_CHANNEL_NAME,
  });

  if (!defaultSalesChannel.length) {
    const { result: salesChannelResult } = await createSalesChannelsWorkflow(
      container
    ).run({
      input: {
        salesChannelsData: [{ name: SALES_CHANNEL_NAME }],
      },
    });
    defaultSalesChannel = salesChannelResult;
  }

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        supported_currencies: [
          {
            currency_code: CURRENCY,
            is_default: true,
            // Entscheidend: erzeugt die price_preference
            // (attribute=currency_code, value=chf, is_tax_inclusive=true).
            //
            // Ohne diese Preference rechnet Medusa die 8.1% MwSt. ON TOP auf
            // den gepflegten Preis (CHF 2.50 → item_total 2.70). Die
            // Preference auf der REGION allein genügt nicht: isTaxInclusive()
            // in @medusajs/pricing greift sie nur, wenn der Preis selbst eine
            // `region_id`-Price-Rule trägt — unsere Preise sind
            // währungsbasiert.
            is_tax_inclusive: true,
          },
        ],
        default_sales_channel_id: defaultSalesChannel[0].id,
      },
    },
  });

  // ─── Region Schweiz ──────────────────────────────────────────
  logger.info("Seeding region data (Schweiz / CHF)...");

  const existingRegions = await regionModuleService.listRegions({
    name: REGION_NAME,
  });

  let region = existingRegions[0];

  if (!region) {
    const { result: regionResult } = await createRegionsWorkflow(container).run({
      input: {
        regions: [
          {
            name: REGION_NAME,
            currency_code: CURRENCY,
            countries: [COUNTRY],
            // Schweizer Detailhandel kommuniziert Endkundenpreise INKLUSIVE
            // MwSt. Ohne dieses Flag schlägt Medusa die 8.1% auf den
            // gepflegten Preis auf (CHF 2.50 → 2.70 im Warenkorb).
            is_tax_inclusive: true,
            // pp_zahls_zahls (offizielles zahls.ch-Plugin) kommt NUR dazu,
            // wenn der Provider auch registriert ist — d.h. wenn
            // ZAHLS_INSTANCE, ZAHLS_API_KEY und ZAHLS_WEBHOOK_SECRET gesetzt
            // sind (siehe medusa-config.ts). Stünde die Kennung hier
            // bedingungslos, schlüge der Seed auf einer Instanz ohne
            // zahls-Konfiguration fehl: createRegionsWorkflow validiert
            // jede payment_provider-ID gegen die geladenen Provider.
            //
            // Auf einer BESTEHENDEN Instanz (Region existiert schon) ändert
            // der Seed nichts — dort den Provider im Admin aktivieren:
            // Einstellungen → Regionen → Schweiz → zahls.ch hinzufügen.
            payment_providers: [
              // pp_system_default bleibt als Dev-/CI-Zahlart aktiv, solange
              // keine zahls.ch-Credentials gesetzt sind. Vor Go-Live von der
              // Region nehmen — die Storefront blockiert ihn in Produktion
              // ohnehin (jibbit-frontend, lib/checkout/payment.ts).
              "pp_system_default",
              ...(isZahlsPluginConfigured(process.env)
                ? [ZAHLS_PROVIDER_ID]
                : []),
            ],
          },
        ],
      },
    });
    region = regionResult[0];
  } else {
    logger.info(`Region "${REGION_NAME}" exists — skipped.`);
  }
  logger.info("Finished seeding regions.");

  // ─── Steuerregion Schweiz ────────────────────────────────────
  logger.info("Seeding tax region (CH, 8.1% MwSt.)...");

  const existingTaxRegions = await taxModuleService.listTaxRegions({
    country_code: COUNTRY,
  });

  if (!existingTaxRegions.length) {
    await createTaxRegionsWorkflow(container).run({
      input: [
        {
          country_code: COUNTRY,
          provider_id: "tp_system",
          default_tax_rate: {
            name: "MwSt. Normalsatz",
            code: "CH-VAT-STD",
            rate: CH_VAT_RATE,
          },
        },
      ],
    });
  } else {
    logger.info("Tax region 'ch' exists — skipped.");
  }
  logger.info("Finished seeding tax regions.");

  // ─── Lager ───────────────────────────────────────────────────
  logger.info("Seeding stock location (Schweiz)...");

  const existingLocations = await stockLocationModuleService.listStockLocations(
    { name: STOCK_LOCATION_NAME }
  );

  let stockLocation = existingLocations[0];

  if (!stockLocation) {
    const { result: stockLocationResult } = await createStockLocationsWorkflow(
      container
    ).run({
      input: {
        locations: [
          {
            name: STOCK_LOCATION_NAME,
            address: {
              city: "Zürich",
              country_code: "CH",
              postal_code: "8005",
              address_1: "Hardturmstrasse 1",
            },
          },
        ],
      },
    });
    stockLocation = stockLocationResult[0];

    await link.create({
      [Modules.STOCK_LOCATION]: {
        stock_location_id: stockLocation.id,
      },
      [Modules.FULFILLMENT]: {
        fulfillment_provider_id: FULFILLMENT_PROVIDER_ID,
      },
    });
  } else {
    logger.info(`Stock location "${STOCK_LOCATION_NAME}" exists — skipped.`);
  }

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        default_location_id: stockLocation.id,
      },
    },
  });

  // ─── Fulfillment ─────────────────────────────────────────────
  logger.info("Seeding fulfillment data (swiss-shipping)...");

  const shippingProfiles = await fulfillmentModuleService.listShippingProfiles({
    type: "default",
  });
  let shippingProfile = shippingProfiles.length ? shippingProfiles[0] : null;

  if (!shippingProfile) {
    const { result: shippingProfileResult } =
      await createShippingProfilesWorkflow(container).run({
        input: {
          data: [
            {
              name: "Default Shipping Profile",
              type: "default",
            },
          ],
        },
      });
    shippingProfile = shippingProfileResult[0];
  }

  const existingSets = await fulfillmentModuleService.listFulfillmentSets(
    { name: FULFILLMENT_SET_NAME },
    { relations: ["service_zones"] }
  );

  let fulfillmentSet = existingSets[0];

  if (!fulfillmentSet) {
    fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
      name: FULFILLMENT_SET_NAME,
      type: "shipping",
      service_zones: [
        {
          name: "Schweiz",
          geo_zones: [
            {
              country_code: COUNTRY,
              type: "country",
            },
          ],
        },
      ],
    });

    await link.create({
      [Modules.STOCK_LOCATION]: {
        stock_location_id: stockLocation.id,
      },
      [Modules.FULFILLMENT]: {
        fulfillment_set_id: fulfillmentSet.id,
      },
    });

    // EINE `calculated` Option, der Preis kommt aus
    // SwissShippingProviderService.calculatePrice(): Brief CHF 3.75,
    // Paket CHF 9.00, ab CHF 69.00 Warenwert gratis. Brief oder Paket
    // entscheidet das Variantengewicht.
    //
    // WARUM NICHT zwei FLAT Optionen mit `item_total`-Rules (naheliegender
    // und in vielen Tutorials so gezeigt)? Weil numerische Rules in Medusa
    // 2.13.6 nachweislich falsch auswerten:
    //
    //   @medusajs/fulfillment/dist/utils/utils.js → isContextValid()
    //     const isDate = (str) => !isNaN(Date.parse(str))
    //     gte: (a, b) => isDate(a) && isDate(b)
    //       ? new Date(a) >= new Date(b)
    //       : Number(a) >= Number(b)
    //
    // `Date.parse("5")` ist in V8 GÜLTIG (→ 2001-05-01), `Date.parse("100")`
    // ebenfalls (→ Jahr 100). Damit gilt `"5" gte "100"` als TRUE und
    // `"5" lt "100"` als FALSE — die Schwelle kehrt sich um. Verifiziert:
    // ein Warenkorb über CHF 5.00 bekam ausschliesslich "Gratisversand".
    //
    // Rules mit String-Gleichheit (enabled_in_store, is_return) sind davon
    // nicht betroffen und bleiben.
    await createShippingOptionsWorkflow(container).run({
      input: [
        {
          name: "Standardversand Schweiz",
          price_type: "calculated",
          provider_id: FULFILLMENT_PROVIDER_ID,
          service_zone_id: fulfillmentSet.service_zones[0].id,
          shipping_profile_id: shippingProfile.id,
          type: {
            label: "Standard",
            description: `Schweizer Post, 2–3 Werktage. Brief CHF ${SHIPPING_LETTER_PRICE.toFixed(2)}, Paket CHF ${SHIPPING_PARCEL_PRICE.toFixed(2)} — ab CHF ${FREE_SHIPPING_THRESHOLD}.00 gratis.`,
            code: "standard",
          },
          // `calculated` Optionen führen KEINE hinterlegten Preise —
          // CreateCalculatedShippingOptionInput kennt kein `prices`.
          rules: [
            {
              attribute: "enabled_in_store",
              value: "true",
              operator: "eq",
            },
            {
              attribute: "is_return",
              value: "false",
              operator: "eq",
            },
          ],
        },
      ],
    });
  } else {
    logger.info(`Fulfillment set "${FULFILLMENT_SET_NAME}" exists — skipped.`);
  }
  logger.info("Finished seeding fulfillment data.");

  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: {
      id: stockLocation.id,
      add: [defaultSalesChannel[0].id],
    },
  });
  logger.info("Finished seeding stock location data.");

  // ─── Publishable API Key ─────────────────────────────────────
  logger.info("Seeding publishable API key data...");
  let publishableApiKey: SeedApiKey | null = null;
  const { data } = await query.graph({
    entity: "api_key",
    fields: ["id"],
    filters: {
      type: "publishable",
    },
  });

  publishableApiKey = data?.[0];

  if (!publishableApiKey) {
    const {
      result: [publishableApiKeyResult],
    } = await createApiKeysWorkflow(container).run({
      input: {
        api_keys: [
          {
            title: "jibbit.ch Webshop",
            type: "publishable",
            created_by: "",
          },
        ],
      },
    });

    publishableApiKey = publishableApiKeyResult as SeedApiKey;
  }

  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: {
      id: publishableApiKey.id,
      add: [defaultSalesChannel[0].id],
    },
  });
  logger.info("Finished seeding publishable API key data.");

  // ─── Kategorien ──────────────────────────────────────────────
  logger.info("Seeding product data (Headshop-Sortiment)...");

  const CATEGORY_NAMES = [
    "Papers",
    "Filter & Tips",
    "Aschenbecher",
    "Kräutermischungen",
  ];

  // ACHTUNG: `productModuleService.listProductCategories()` liefert die Zeilen
  // OHNE `name` (das Feld ist nicht in der Default-Selektion — `cat.name` ist
  // null). Ein lokaler Namensvergleich darauf schlägt still fehl und der Seed
  // lief beim zweiten Lauf in "Product category with handle: papers, already
  // exists". query.graph selektiert explizit und ist hier die richtige Quelle.
  const { data: existingCategories } = await query.graph({
    entity: "product_category",
    fields: ["id", "name"],
  });

  const missingCategories = CATEGORY_NAMES.filter(
    (name) => !existingCategories.some((cat: any) => cat.name === name)
  );

  let categories: { id: string; name: string }[] = existingCategories.filter(
    (cat: any) => CATEGORY_NAMES.includes(cat.name)
  );

  if (missingCategories.length) {
    const { result: categoryResult } = await createProductCategoriesWorkflow(
      container
    ).run({
      input: {
        product_categories: missingCategories.map((name) => ({
          name,
          is_active: true,
        })),
      },
    });
    categories = [...existingCategories, ...categoryResult];
  }

  const categoryId = (name: string): string => {
    const found = categories.find((cat) => cat.name === name);
    if (!found) {
      throw new Error(`Seed: product category "${name}" not found.`);
    }
    return found.id;
  };

  /**
   * Sortiment. Alle Preise in CHF als DEZIMALBETRÄGE (4.5 === CHF 4.50).
   * Keine `images` — für die echten Produktbilder liegen keine Rechte /
   * URLs vor; die pflegt der Shop-Betreiber im Admin nach.
   */
  const productDefinitions = [
    {
      title: "RAW Classic King Size Slim",
      handle: "raw-classic-king-size-slim",
      category: "Papers",
      description:
        "Ungebleichte Blättchen aus reinem Naturfaser-Hanf. RAW Classic ist der Klassiker unter den King Size Slim Papers — dünn, langsam abbrennend, ohne Chlor und ohne Farbstoffe. 32 Blatt pro Heftchen.",
      weight: 12,
      variants: [
        { title: "1 Heftchen", sku: "RAW-CLS-KSS-1", price: 2.5 },
        { title: "5er Pack", sku: "RAW-CLS-KSS-5", price: 11.5 },
        { title: "Box (50 Heftchen)", sku: "RAW-CLS-KSS-50", price: 99 },
      ],
    },
    {
      title: "RAW Black Organic Hemp 1 1/4",
      handle: "raw-black-organic-hemp-1-1-4",
      category: "Papers",
      description:
        "Die dünnsten Papers von RAW: Organic Hemp im Black-Finish, 1 1/4 Format. Bio-Hanf, ungebleicht, mit natürlichem Gummi-Arabikum-Streifen. 50 Blatt pro Heftchen.",
      weight: 10,
      variants: [
        { title: "1 Heftchen", sku: "RAW-BLK-114-1", price: 2.9 },
        { title: "5er Pack", sku: "RAW-BLK-114-5", price: 13.5 },
      ],
    },
    {
      title: "Elements Ultra Thin Rice King Size Slim",
      handle: "elements-ultra-thin-rice-kss",
      category: "Papers",
      description:
        "Blättchen aus Reisstroh, die praktisch rückstandsfrei abbrennen — es bleibt nur feine Asche. Gummierung aus Zuckersaft. 32 Blatt pro Heftchen.",
      weight: 11,
      variants: [
        { title: "1 Heftchen", sku: "ELE-UTR-KSS-1", price: 2.9 },
        { title: "5er Pack", sku: "ELE-UTR-KSS-5", price: 13.5 },
      ],
    },
    {
      title: "OCB Premium Black King Size Slim",
      handle: "ocb-premium-black-kss",
      category: "Papers",
      description:
        "Der französische Klassiker. Ultradünnes, langsam abbrennendes Papier mit gleichmässigem Zug. 32 Blatt pro Heftchen.",
      weight: 11,
      variants: [
        { title: "1 Heftchen", sku: "OCB-PRB-KSS-1", price: 2.4 },
        { title: "5er Pack", sku: "OCB-PRB-KSS-5", price: 10.9 },
        { title: "Box (50 Heftchen)", sku: "OCB-PRB-KSS-50", price: 94 },
      ],
    },
    {
      title: "Smoking Blue King Size",
      handle: "smoking-blue-king-size",
      category: "Papers",
      description:
        "Spanische Papers mit mittlerer Grammatur — etwas robuster als Ultra-Thin und dadurch angenehm zu drehen. 33 Blatt pro Heftchen.",
      weight: 12,
      variants: [
        { title: "1 Heftchen", sku: "SMK-BLU-KS-1", price: 2.2 },
        { title: "5er Pack", sku: "SMK-BLU-KS-5", price: 9.9 },
      ],
    },
    {
      title: "Zig Zag Blue Regular",
      handle: "zig-zag-blue-regular",
      category: "Papers",
      description:
        "Kurzformat-Blättchen im Regular-Size. Zig Zag Blue ist seit Generationen der Standard für kurze Drehs. 50 Blatt pro Heftchen.",
      weight: 9,
      variants: [
        { title: "1 Heftchen", sku: "ZIG-BLU-REG-1", price: 1.9 },
        { title: "5er Pack", sku: "ZIG-BLU-REG-5", price: 8.5 },
      ],
    },
    {
      title: "PURIZE Aktivkohlefilter 6 mm",
      handle: "purize-aktivkohlefilter-6mm",
      category: "Filter & Tips",
      description:
        "Aktivkohlefilter mit 6 mm Durchmesser und Keramikkappen gegen Durchrutschen. Filtert Teer und Schadstoffe, ohne den Zug zu blockieren. Made in Germany.",
      weight: 60,
      variants: [
        { title: "50 Stück", sku: "PUR-AK6-50", price: 5.9 },
        { title: "100 Stück", sku: "PUR-AK6-100", price: 9.9 },
        { title: "250 Stück", sku: "PUR-AK6-250", price: 21.9 },
      ],
    },
    {
      title: "PURIZE XTRA Slim Aktivkohlefilter 5.9 mm",
      handle: "purize-xtra-slim-5-9mm",
      category: "Filter & Tips",
      description:
        "Die Slim-Variante mit 5.9 mm — passt in schlankere Drehs und behält trotzdem die volle Aktivkohle-Füllung. Mit Keramikkappen.",
      weight: 55,
      variants: [
        { title: "50 Stück", sku: "PUR-XTS-50", price: 6.5 },
        { title: "100 Stück", sku: "PUR-XTS-100", price: 10.9 },
      ],
    },
    {
      title: "RAW Perforated Tips",
      handle: "raw-perforated-tips",
      category: "Filter & Tips",
      description:
        "Ungebleichte, perforierte Filter-Tips zum Selberrollen. 50 Tips pro Heftchen, perforiert für einen sauberen Roll-In.",
      weight: 15,
      variants: [
        { title: "1 Heftchen", sku: "RAW-TIP-PER-1", price: 1.5 },
        { title: "10er Pack", sku: "RAW-TIP-PER-10", price: 12.9 },
      ],
    },
    {
      title: "Angel Filter Tips Slim",
      handle: "angel-filter-tips-slim",
      category: "Filter & Tips",
      description:
        "Schmale Kartontips im Slim-Format. Stabiler Karton, kein Nachrutschen, neutral im Geschmack. 50 Tips pro Heftchen.",
      weight: 14,
      variants: [
        { title: "1 Heftchen", sku: "ANG-TIP-SLM-1", price: 1.4 },
        { title: "10er Pack", sku: "ANG-TIP-SLM-10", price: 11.9 },
      ],
    },
    {
      title: "Greengo Kräutermischung",
      handle: "greengo-kraeutermischung",
      category: "Kräutermischungen",
      description:
        "Tabakfreie Kräutermischung aus Papaya-, Eukalyptus- und Kokosblättern. Nikotinfrei und ohne Zusatzstoffe — der Standard-Ersatz für Tabak beim Mischen.",
      weight: 30,
      variants: [
        { title: "30 g", sku: "GRG-KRM-30", price: 6.9 },
        { title: "3 x 30 g", sku: "GRG-KRM-90", price: 18.9 },
      ],
    },
    {
      title: "dubi Glasaschenbecher",
      handle: "dubi-glasaschenbecher",
      category: "Aschenbecher",
      description:
        "Schwerer Aschenbecher aus massivem Pressglas mit vier Ablagekerben. Spülmaschinenfest, standfest, unkaputtbar — der Klassiker für Tisch und Balkon.",
      weight: 620,
      variants: [
        { title: "Klar", sku: "DUB-ASB-CLR", price: 14.9 },
        { title: "Rauchglas", sku: "DUB-ASB-SMK", price: 16.9 },
      ],
    },
    {
      title: "dubi Glasaschenbecher XL",
      handle: "dubi-glasaschenbecher-xl",
      category: "Aschenbecher",
      description:
        "Die grosse Ausführung mit 16 cm Durchmesser für Runden zu mehreren. Massives Pressglas, sechs Ablagekerben, tiefe Mulde.",
      weight: 1150,
      variants: [{ title: "Klar", sku: "DUB-ASB-XL-CLR", price: 24.9 }],
    },
  ];

  // Bereits vorhandene Produkte überspringen (Handle ist unique).
  // Gleicher Fallstrick wie bei den Kategorien → query.graph mit explizitem
  // Feld statt listProducts().
  const { data: allProducts } = await query.graph({
    entity: "product",
    fields: ["id", "handle"],
  });
  const existingHandles = new Set(allProducts.map((p: any) => p.handle));

  const productsToCreate = productDefinitions.filter(
    (p) => !existingHandles.has(p.handle)
  );

  if (productsToCreate.length) {
    await createProductsWorkflow(container).run({
      input: {
        products: productsToCreate.map((product) => ({
          title: product.title,
          handle: product.handle,
          description: product.description,
          category_ids: [categoryId(product.category)],
          weight: product.weight,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile!.id,
          options: [
            {
              title: "Variante",
              values: product.variants.map((v) => v.title),
            },
          ],
          variants: product.variants.map((variant) => ({
            title: variant.title,
            sku: variant.sku,
            options: {
              Variante: variant.title,
            },
            prices: [
              {
                // CHF als DEZIMALBETRAG — 4.5 === CHF 4.50
                amount: variant.price,
                currency_code: CURRENCY,
              },
            ],
          })),
          sales_channels: [
            {
              id: defaultSalesChannel[0].id,
            },
          ],
        })),
      },
    });
    logger.info(`Created ${productsToCreate.length} products.`);
  } else {
    logger.info("All products already exist — skipped.");
  }
  logger.info("Finished seeding product data.");

  // ─── Lagerbestände ───────────────────────────────────────────
  logger.info("Seeding inventory levels...");

  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id"],
  });

  const { data: existingLevels } = await query.graph({
    entity: "inventory_level",
    fields: ["inventory_item_id", "location_id"],
  });

  const levelKey = (itemId: string, locationId: string) =>
    `${itemId}::${locationId}`;
  const seenLevels = new Set(
    existingLevels.map((lvl: any) =>
      levelKey(lvl.inventory_item_id, lvl.location_id)
    )
  );

  const inventoryLevels: CreateInventoryLevelInput[] = [];
  for (const inventoryItem of inventoryItems) {
    if (seenLevels.has(levelKey(inventoryItem.id, stockLocation.id))) {
      continue;
    }
    inventoryLevels.push({
      location_id: stockLocation.id,
      stocked_quantity: 1000,
      inventory_item_id: inventoryItem.id,
    });
  }

  if (inventoryLevels.length) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: inventoryLevels,
      },
    });
    logger.info(`Created ${inventoryLevels.length} inventory levels.`);
  } else {
    logger.info("Inventory levels already present — skipped.");
  }

  logger.info("Finished seeding inventory levels data.");
  logger.info("jibbit.ch seed complete.");
}
