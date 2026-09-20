# SEO competitor research: how Swiss headshops built their authority

Research date: 2026-09-20. All fetches, probes and lookups below were done on that date unless stated otherwise.

Evidence labels used throughout:

- **[V]** verified fact, with source (URL or direct fetch of the competitor's own site)
- **[I]** reasonable inference from verified facts
- **[U]** unknown / not obtainable without paid tools

## 0. Read this first: what could NOT be obtained

| Metric | Status |
|---|---|
| Ahrefs DR, backlink and referring-domain counts | **[U]** Free checker (`ahrefs.com/website-authority-checker`) only returns the form; results sit behind a Cloudflare/captcha step. No number in this report is an Ahrefs number. |
| Moz DA / linking root domains | **[U]** `moz.com` could not be fetched at all by the tooling. |
| Majestic TF/CF | **[U]** Captcha + login wall. |
| Semrush authority / organic traffic | **[U]** Public overview URL returned 404. |
| Ubersuggest | **[U]** Login required, not attempted further. |
| Similarweb | **[V] partially.** Public pages were readable (dataset: August 2026). They give ranks and an order-of-magnitude visits figure, but no referrers, no backlinks. For sites this small Similarweb is modelled and noisy; the near-identical "organic search ~33%" share on 7 of 9 sites looks like a model default, not a measurement. Treat as ordinal ranking only. |
| Tranco top-list rank | **[V]** `tranco-list.eu/api/ranks/domain/<d>`: only fourtwenty.ch (~2.9M), smokee.ch (~4.2M) and hanfpost.ch (~4.1M, last seen 2026-08-31) appear at all. The other six are not in the list. |
| Google reviews count/rating per store | **[U]** Google Maps is not fetchable; only one indirect data point (Werners, via Rating Captain, dated Dec 2022). |
| Instagram/TikTok follower counts | **[U]** Instagram serves no metadata to non-logged-in fetches. |
| Swiss Google rankings | **[U]** The search tool used is US-based. Any "who ranks" statement below is NOT a Swiss SERP observation. |
| Google Merchant/Shopping presence | **[U]** not observable; see policy note in section 5. |
| CannaTrade exhibitor list | **[U]** age gate blocks fetch; only one search snippet (Tamar, Hall 1 Stand 139). |
| IG Hanf member list and fees | **[U]** `www.ighanf.ch` has a broken TLS certificate; fees not published in search results. |

Consequence: the "authority" comparison below rests on age, physical footprint, catalogue size, observable link sources and Similarweb/Tranco ordinal ranks. If real DR/referring-domain numbers are needed, someone has to type the nine domains into the Ahrefs free checker in a browser (about 10 minutes of manual work).

## 1. Comparison table

Shops covered (8 + 1 side note): the five requested, plus fourtwenty.ch, smokee.ch and hempbasement.ch, which Similarweb lists as the closest competitors of breakshop/werners and which surfaced repeatedly in searches. hanfpost.ch is a CBD shop, kept as a side note because of its review data. **head-nature.ch no longer exists as a Swiss shop: it redirects to head-shop.de [V, curl].**

| Shop | Company, since | Stores | First Wayback capture | Platform | Sitemap size (DE) | Languages / hreflang | Blog / guides | Product JSON-LD | Similarweb CH rank / visits figure (Aug 2026) |
|---|---|---|---|---|---|---|---|---|---|
| fourtwenty.ch | Fourtwenty GmbH, 2002 (online since 2006) | 4 (Bern x2, Ittigen 1000 m2, Fribourg) + B2B wholesale to 140+ shops | 2004-04-15 | Magento | not discoverable (no sitemap in robots; `/media/sitemap.xml` is a PNG) | DE/FR/IT claimed; no hreflang on home | `/blog` exists but shows 0 posts; heavy category copy instead | none (microdata Product/Offer only, EAN in custom prop) | **#5,523** / ~33K, organic 76%, 7.6 pages/visit |
| smokee.ch | Dampfwaren AG, 2016 | 6 + pop-up | 2017-04-21 | PrestaShop | index present, child sitemap returns 404 | DE only | `/blog.html` "Ratgeber" | **best of group**: brand, gtin13, sku, Offer | #25,912 / ~19.5K |
| breakshop.ch | BREAKshop AG, 2000 | 2 (St. Gallen) | 2006-11-09 | xt:Commerce 6.5.5 | none found (404) | DE (hreflang de + x-default) | none found | thin, no gtin (earlier finding) | #33,689 / ~12.4K |
| derhollaender.ch | Der Hollaender GmbH, ">25 years experience" claim | 1 (Adligenswil LU, 200 m2) | 2018-06-26 | WooCommerce + AIOSEO Pro | 1,166 products, 116 categories, 152 tags, 11 attachment sitemaps | DE only, no hreflang | none (no post sitemap) | name/desc/image/sku/gtin/Offer, no brand/shipping/returns (earlier finding) | #34,972 / not shown |
| wernersheadshop.ch | Hemag Nova AG (wholesaler, Aadorf); shops founded 1983 | 4-5 (Zurich x3, Chur, Zug) | **2000-04-07** | Magento 2 | 2,921 URLs per language (incl. 168 glossary, 5 blog) x 4 languages | **DE/EN/FR/IT with correct `xx-CH` hreflang** | 5 blog posts, all 2026-dated; 168-term vape glossary | Product + Offer + aggregateRating (4.8 / 13 on sample), no gtin/brand | #35,510 / ~9.8K |
| hempbasement.ch | Hemp Basement KLG, Romanshorn | 1 | 2017-04-22 | WooCommerce 11 | 3,494 products, 198 categories, **4,233 product tags**, 31 posts | DE only | 31 posts (CBD/health/legalisation) | gtin + aggregateRating + review, no brand | #91,176 / ~4.1K, bounce 64% |
| stayhighswiss.ch | Stayhigh GmbH, site 2018, GmbH 2019-02-11, CHF 20k capital | 1 (Reiden LU, open Mon-Fri 15-18h) | 2021-12-25 (.ch); 2018-08-06 (.com, now redirects) | **Wix** | 2,547 products, 280 categories, 96 blog posts, 187 pages | DE/EN/FR/IT but hreflang uses wrong regions (`de-de`, `en-gb`, `fr-fr`, `it-it`) | 96 posts (promos, vape launches, Purize guides, THC test) | name/desc/image/sku/Offer, no gtin/brand | **#91,539** / not shown |
| tamar.ch | Tamar Trade GmbH + Delta Grow AG, 1997 | 3 (Winterthur) | 2004-06-14 | custom CMS ("ppadmin level1") | 6,260 products, 392 navigation URLs | DE (EN exists), no hreflang on home | none found | **no JSON-LD at all** | #99,408 / not shown |
| *hanfpost.ch (side note, CBD)* | unknown [U] | none found | 2017-11-23 | WooCommerce + WP Rocket | ~1,695 products, 24 posts | DE | 24 posts (CBD basics, 3 paper-related) | not probed | #30,540 / ~12.5K, 5 min/visit |

Sources for the table: direct curl of each homepage, robots.txt and sitemaps; `web.archive.org/cdx/search/cdx?url=<domain>&limit=1`; `tools/seo/probe-jsonld.mjs`; `similarweb.com/website/<domain>/`; company facts from the sources cited per shop below.

Note on the Similarweb "visits" figure: the public page labels the block "last 3 months" while the headline number is normally the latest month. Read it as "roughly 10-30K visits per month for the leaders, under 5K for the tail", nothing finer.

## 2. Per-shop notes

### fourtwenty.ch — the actual market leader online
- [V] Started 2002 as a <20 m2 shop in Bern, online since 2006, 16 staff in 2018, wholesale to 140+ Swiss shops, 1000 m2 grow center in Ittigen. Source: Hanf Magazin reportage, 2018-11-03, https://www.hanf-magazin.com/hanf-business/reportagen/vom-kleinen-hanfladen-zum-etablierten-grosshaendler/ (editorial, names the domain but does not link it).
- [V] Homepage shows partner logos: IG Hanf, Legalize It, SVTA, Medcan, SNV, Berufsbildung Plus. Runs `b2b.fourtwenty.ch`. Own-brand products ("Fourtwenty Grip") are sold on Galaxus: https://www.galaxus.ch/de/brand/fourtwenty-120848.
- [V] Link sources seen: local.ch, search.ch, grow.de link list, hanfplatz.de (links to fourtwenty.ch), CleanU shop finder, cannaviva.ch editorial mention (no link), weedmaps, grower.ch forum thread (https://www.grower.ch/forum/threads/3007-bern-fourtwenty.24424/), Hanf Magazin.
- [V] Category copy is the strongest in the market: `/headshop/papers.html` has roughly 1,200-1,400 words, six H3 sub-sections (formats, materials, bleached vs unbleached, thickness, gum/tips, storage), a 6-question FAQ, internal links to brand subcategories, 271 products, tier prices, and **boxes as separate SKUs/URLs** (e.g. `/ocb-black-slim-kingsize-box-ft-ocbblslksbo.html`).
- [V] Structured data is the weakest: no Product JSON-LD, only microdata. [I] Their visibility is therefore not a markup effect; it is brand + age + catalogue + category content. Top Similarweb keyword is the brand name "fourtwenty".

### wernersheadshop.ch — oldest domain, wholesaler-backed
- [V] Werners Head Shop founded 1983 (Werner and Marcel Bösch), Chur branch 2013, second generation since 2021. Online shop operated by Hemag Nova AG, Aadorf (UID CHE-103.271.777), "one of the leading wholesale companies in Switzerland ... ships tens of thousands of parcels per year". Sources: https://www.hemagnova.ch/ueber-uns/firmengeschichte/ , https://www.help.ch/firma/CHE-103.271.777/hemag-nova-ag-aadorf . Store count is stated as five (Hemag Nova) or four (third-party) — [U] exact.
- [V] Domain first captured 2000-04-07: 26 years of link accumulation. Also owns `werners-head-shop.de`.
- [V] Certified "Swiss Online Garantie" (Handelsverband.swiss), certification date 05.08.2025, listing links to the shop: https://www.swiss-online-garantie.ch/listing/wernersheadshop-ch/
- [V] 1,039 Google-sourced ratings, average 4.60, aggregated by Rating Captain, last updated 2022-12-08 (across stores): https://reviews.ratingcaptain.com/de-ch/512205/wernersheadshop-ch
- [V] Other link sources: Yelp (3 store pages), zuri.net city guide, bitcoinwide.com (accepts Bitcoin), dampfertreff.ch forum thread, coupert coupon page, grow.de, CleanU shop finder, weedmaps/cannawayz.
- [V] Only competitor with clean 4-language hreflang (`de-CH`, `en-CH`, `fr-CH`, `it-CH`, `x-default`). Homepage carries FAQPage markup (12 Q&A). Category page for cigarette papers has **zero** copy. The blog has 5 posts, all with "2026" in the slug (bong buying guide, grinder guide, CBD legal status, snus trend) — [I] a content push that only just started. robots.txt blocks GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended.

### breakshop.ch
- [V] BREAKshop AG, UID CHE-365.211.087, since 2000, headshop at Linsebühlstrasse 9 and pick-up warehouse/growshop in St. Gallen Winkeln. Sources: https://www.breakshop.ch/de/impressum , https://www.moneyhouse.ch/en/company/breakshop-ag-20554517271
- [V] Link sources: search.ch, Yelp, grow.de, CleanU shop finder, webwiki.ch, shisha-forum.de thread ("Breakshop.ch Deutschland?"), X/Facebook/Instagram profiles, coupon scraper sites.
- [V] Brand category pages have ~280 words of intro (OCB page), no headings, no FAQ; tier/variant price ranges visible. No XML sitemap found, no blog found. Similarweb keywords are vaporizer-support queries ("mighty ladegerät", "crafty gebrauchsanweisung").

### derhollaender.ch
- [V] Der Hollaender GmbH, Sagihof 4, Adligenswil; one 200 m2 store; primarily a **growshop** (title tag, Similarweb keywords "flowermill, garland, bat guano, fan controller"). Sources: https://derhollaender.ch/info-kontakt/ , https://search.ch/tel/adligenswil/sagihof-4/der-hollaender-ch
- [V] Link sources: local.ch, search.ch, Yelp, Cylex, handwerkatelier.ch, CANNA dealer locator candidate (https://www.canna.ch/stores — appeared for the query, listing not verified [U]).
- [V] No blog, no hreflang, 11 image-attachment sitemaps (index bloat). [I] Its visibility is grow-equipment long tail plus local Lucerne citations; little here is relevant to a papers shop.

### tamar.ch
- [V] Since 1997, "one of the largest and most modern headshops in Switzerland", 6000+ articles, three Winterthur locations. Runs a small network of own domains that cross-link: tamargrow.ch, cbd.ch, tamarheadshop.ch (redirects to tamar.ch). Sources: https://www.tamar.ch/de/ueber-uns/standorte , https://www.tamargrow.ch/de/links/growshop
- [V] CannaTrade exhibitor (Hall 1, Stand 139, per cannatrade.ch search snippet). Listed at mushroom-magazine.com, CleanU shop finder, weedmaps/cannapages/cannawayz, oeffnungszeitenbuch.de.
- [V] Technically the weakest site: custom CMS, no JSON-LD on product pages, sitemap URLs with opaque `?context=` tokens. Lowest Similarweb CH rank of the group (#99,408). [I] Proof that age and store footprint alone do not produce online traffic.

### stayhighswiss.ch — does the evidence support "gets a lot of orders"?
Contradicting [V]:
- Similarweb CH rank #91,539 — 17x worse than fourtwenty, ~3x worse than breakshop/werners/derhollaender; too small for Similarweb to publish a visits figure. Not in the Tranco list.
- Trustpilot: 2 reviews (https://ch.trustpilot.com/review/stayhighswiss.com). Facebook: 3 reviews. Own homepage HTML mentions "10 reviews". Main Instagram account was suspended and restarted (their own blog post).
- CHF 20k GmbH founded 2019, one owner-manager (Moneyhouse), store open 3 hours on weekdays.
- Wix store; keyword-stuffed long footer text; wrong hreflang regions.

Supporting [V]:
- Large catalogue for its size (2,547 product URLs), 96 blog posts, four languages, own iOS/Android app, free shipping with no minimum plus free gifts per order, "one tree per order", WhatsApp support, listed in the CleanU shop finder next to the big names.
- Similarweb keywords are disposable-vape terms ("elfbar nx 7000", "vozol switzerland", "lost mary lux 7000") plus "bong", "grinder" — [I] whatever volume they have is driven by vapes and CBD, not papers.

Verdict: **[I] no public signal supports high order volume from organic search; several contradict it.** [U] App orders, repeat customers, social/TikTok-driven and walk-in sales are invisible to every source used here, and Google review counts could not be read. If the owner's belief comes from visible activity (packaging posts, giveaways), that is marketing output, not order evidence. What is worth copying from them is the offer mechanics (free shipping, freebies, app/WhatsApp retention), not their SEO.

### smokee.ch
- [V] Dampfwaren AG, since 2016, six stores (Luzern, Zurich, Aarau, Baden, Olten, Thun) + pop-up, free shipping from CHF 69, order by 18:00 for next-day delivery. Vape/tobacco first, headshop second. Boxes are separate products with the EAN in the URL (`/ocb/4946-ocb-premium-slim-rolls-box-3057067089247.html`). Best Product markup in the group (brand + gtin13), but one JSON-LD block on every page is syntactically broken.

### hempbasement.ch
- [V] One store in Romanshorn, WooCommerce, 3,494 products, ~800-900 words of copy under the main headshop category with 50+ internal links, markup with gtin + aggregateRating + reviews. 4,233 tag archive URLs in the sitemap. Similarweb: 4.1K, 64% bounce, 27 s visits. [I] Shows that on-page work alone lifts a site only to the bottom of this group.

### hanfpost.ch (side note)
- [V] Trusted Shops: **4,974 reviews, 4.82/5, certified since 05.10.2020**: https://www.trustedshops.ch/bewertung/info_X10FA27A3F33EB77EF73F4C9413BA20DE.html . [I] At typical 10-20% review rates that is on the order of 25-50K orders in five years — the only hard order-volume proxy found for any shop. Many coupon-aggregator pages point at it (coupert, rabattzettel, schweizergutschein.net). 24 blog posts, three of them about papers (OCB, RIPS, Smoking Blue).

## 3. What actually drives their authority

1. **Age plus physical retail, not SEO craft.** Five of the eight have domains first captured 2000-2006 and 2-6 stores. Every store produces free citations that an online-only shop does not get automatically: local.ch, search.ch, Google Maps (Werners: 1,039 ratings by 2022), Yelp, Cylex, zuri.net, oeffnungszeitenbuch, stadtbranchenbuch, weedmaps-type scrapers. Stores also create brand searches; fourtwenty's top keyword is its own name. [V sources, I conclusion]
2. **Position in the supply chain.** The strongest two are wholesalers (Fourtwenty supplies 140+ shops; Hemag Nova is a distributor that owns Werners online). That earns links nobody else can get: manufacturer shop finders (CleanU lists Fourtwenty, Breakshop, Tamar, Hemag Nova/Werners, Stayhigh, Holos, HydroDreams, Vision of Hemp), association logos/memberships (IG Hanf, Legalize It, SVTA), trade-fair exhibitor pages (CannaTrade), trade press (Hanf Magazin), a B2B subdomain, own-brand listings on Galaxus. [V]
3. **Catalogue breadth in adjacent high-demand categories.** Similarweb keywords for every shop are vapes, tobacco, vaporizer support or grow gear — none are paper/filter terms. 1,200-6,300 product URLs each. [V data, I conclusion: papers are not where their traffic comes from, which is an opening, but also a sign the papers niche alone is small.]
4. **Content is thin almost everywhere.** Only Fourtwenty has real category copy with FAQ. Blogs: Werners 5 posts (all 2026), Hanfpost 24, Hemp Basement 31, Stayhigh 96 (mostly promos), Breakshop/Tamar/Der Hollaender none. Structured data ranges from absent (Tamar, Fourtwenty JSON-LD) to decent (Smokee). [V] There is no content moat.
5. **Trust seals and review platforms are used by few, and work for those who do.** Hanfpost (Trusted Shops, ~5K reviews), Werners (Swiss Online Garantie; aggregateRating in markup). Others show nothing. [V]

## 4. Action list for jibbit (next 3 months, prioritised)

### A. Link targets that are realistically obtainable

| # | Target | URL / how to apply | Cost | Notes |
|---|---|---|---|---|
| 1 | **localsearch basic entry** (local.ch + search.ch) | https://www.localsearch.ch/en/start-free/ — enter phone number, follow flow | free | Every competitor has both. Needs a business phone and address. Decline the upsell calls. |
| 2 | **Swiss Online Garantie / Handelsverband.swiss** | https://www.swiss-online-garantie.ch/onlineshops/shop-zertifizieren/ ; pricing at `/onlineshops/kosten/` | CHF 500 for start-ups (<3 years), otherwise CHF 1,000 | Listing page with link to the shop + recognised Swiss trust seal + 14-day return requirement. Werners holds it. Check the criteria PDF first for age-restricted goods: https://handelsverband.swiss/wp-content/uploads/2024/11/Pruefkriterien-Swiss-Online-Garantie-final-DEU.pdf |
| 3 | **Supplier / brand "where to buy" pages** | Ask every distributor and brand jibbit buys from for a Bezugsquellen/shop-finder entry. Verified example: CleanU shop finder https://www.cleanu.shop/en/shop-finder ("Your shop is missing here? Send us your details", order@cleanu.shop) | free | This is the link type that separates the leaders. [U] No public Swiss dealer locator was verified for RAW, OCB, Gizeh or Purize (Purize CH is handled by goodvibe.ch as exclusive dealer; purize-filters.ch). Storz & Bickel has one (https://www.storz-bickel.com/en-us/storelocator) but it requires authorised-retailer status and is off-range for jibbit. |
| 4 | **grow.de link list** (DACH head/grow/shisha shops) | https://www.grow.de/growshops-headshops-shishashops — "schreib uns doch einfach eine Mail" | free | Lists Breakshop, Fourtwenty, Smokee, Werners. Organised by postcode, so a physical address helps. |
| 5 | **Review platform profile** | Trustpilot free business profile, or Trusted Shops if budget allows | free / paid | Goal is a review stream that can feed `aggregateRating` (Werners and Hemp Basement get stars this way). Ask for a review in the shipping-confirmation mail from order #1. |
| 6 | **Free general directories, a handful only** | Yelp (https://biz.yelp.com), Cylex (https://ch.cylex.de), stadtbranchenbuch.ch | free | Competitors all have these. Consistent name/address/phone. Low value each; stop after 4-5. |
| 7 | **IG Hanf membership** | https://ighanf.ch/en/mitgliedschaft/ , info@ighanf.ch | [U] fee not public | Fourtwenty displays the logo. Relevance is moderate for a papers/accessories shop with no CBD; ask whether members get a linked directory entry before paying. |
| 8 | **Trade press pitch** | Hanf Magazin (hanf-magazin.com, ran the Fourtwenty profile), mushroom-magazine.com (lists Tamar) | free if editorial | Angle that is actually new: "whole displays at quantity prices for consumers and small kiosks". One good story beats 20 directories. |
| 9 | **Forums, as a participant** | grower.ch forum, dampfertreff.ch, shisha-forum.de all have shop threads about competitors | free | Answer questions under a disclosed shop account; do not drop links. Slow, but these threads are where Swiss buyers ask "where do I order". |
| 10 | **Google Business Profile** | only if jibbit has a staffed pick-up address | free | [I] Pure online shops are not eligible; if pick-up with opening hours is feasible, this unlocks Maps reviews, the largest review pool competitors have. |
| 11 | **Hanfplatz.de** | https://hanfplatz.de/hanf-shop-vorschlagen | suggestion form free [U whether it yields a link]; premium EUR 349-1,690/year | Submit the free suggestion; do not buy premium. |
| 12 | **toppreise.ch** | https://www.toppreise.ch/dealer-registration | [U] fees | Requires commercial-register entry **and VAT registration**, plus a CSV/XML feed. Only relevant once jibbit is VAT-liable; [U] whether papers categories exist there. Park it. |
| — | Automatic | moneyhouse.ch, help.ch, easymonitoring | free | Appear by themselves once the company is in the commercial register. |

Not in the 3-month window: CannaTrade exhibitor profile (2026 edition was 29-31 May 2026; next dates not yet verified) — visit and network with brands instead of exhibiting.

### B. Content gaps jibbit can own

1. **Displays/boxes as first-class landing pages.** Fourtwenty, Smokee and Breakshop all treat the box as a separate SKU/URL or variant, but nobody explains it. Build "OCB Slim Box kaufen (50 Heftchen)"-type pages with price per booklet, price per leaf, and the quantity-discount ladder in a visible table. This is jibbit's actual differentiator and matches a real query pattern ("... Box", "... Display", "Grosspackung").
2. **Category copy in the Fourtwenty format**, because it is the only format in the market that demonstrably coexists with top traffic: 600-1,200 words under the grid, H2/H3 by decision criterion (format, material, thickness g/m2, bleached vs unbleached, gum), 5-6 question FAQ with FAQPage markup, links to brand subcategories. Werners has zero copy on its papers category; Breakshop has 280 words.
3. **Comparison and sizing guides nobody has**: paper sizes (Regular, 1 1/4, King Size Slim, rolls) with mm tables; OCB vs RAW vs Gizeh vs Smoking by line; filter diameters (5.3/6/7/8 mm, activated carbon) and which paper they fit; ashtray materials. Hanfpost has three brand posts, Stayhigh two Purize posts; that is the whole market.
4. **French.** Only Werners has correct CH-French hreflang; Fourtwenty has FR without hreflang on the home page; Stayhigh's is mis-regioned; five shops are German only. A properly tagged `fr-CH` version of the top 20 category/box pages is the cheapest uncontested territory. Do `de-CH` first, then `fr-CH`; Italian later.
5. **Kiosk/reseller page.** Fourtwenty has a whole B2B subdomain. A single "Für Kioske, Bars und Vereine" page describing display pricing and invoicing fits jibbit's model and is a natural link target for suppliers.
6. **Structured data above the market level** (cheap on Next.js): add `brand`, `gtin13`, `shippingDetails`, `hasMerchantReturnPolicy`, and model single vs display as separate Products or an `AggregateOffer` with explicit `eligibleQuantity` tiers. Only Smokee ships brand+gtin today. Expect rich-result eligibility, not rankings.

### C. What is NOT worth copying

- **Physical stores, 20-year-old domains, wholesale status.** These are the real moat and cannot be replicated in a quarter. Plan for a slower curve instead of trying to out-directory them.
- **Google Shopping / Merchant Center as a channel.** Google's policy excludes "rolling papers, pipes, tobacco filters" from Shopping ads and free listings (https://support.google.com/merchants/answer/6149970 and the Tobacco policy https://support.google.com/adspolicy/answer/16489929). Feeds will be disapproved; do not build the roadmap on it.
- **Catalogue expansion into vapes, nicotine, CBD or grow gear just because that is where competitor traffic comes from.** It is where their traffic comes from [V], but it brings age-verification, tobacco-product law and payment-provider friction and erases jibbit's focus.
- **Tag/attachment index bloat** (Hemp Basement: 4,233 tag URLs; Der Hollaender: 11 attachment sitemaps) and **Stayhigh-style keyword-stuffed footer text** with mis-regioned hreflang.
- **Paid directory links**: hanfplatz.de premium (EUR 349+), webwiki.ch (EUR 95/year for "one dofollow link"). Coupon aggregators (coupert, rabattzettel, chrabatt) create pages on their own once a shop has codes; do not chase them.
- **Dispensary scrapers** (weedmaps, cannapages, cannawayz): auto-generated from store data, irrelevant to an online-only shop.
- **Blocking AI crawlers** as Werners and Der Hollaender do. A new shop with no brand searches gains more from being quotable in AI answers than it loses.
- **A blog for its own sake.** Stayhigh's 96 posts sit on the second-worst traffic rank in the group. Write the five guides in B.3 well instead.

### Top 8, in order

1. localsearch free entry (local.ch + search.ch), consistent NAP everywhere.
2. Email every supplier/brand for a dealer/"where to buy" listing; start with any that already list competitors (CleanU verified).
3. Box/display landing pages with per-unit price tables and tier pricing — the one thing no competitor explains.
4. Fourtwenty-format category copy + FAQ on papers, filters, rolls, ashtrays (DE).
5. Swiss Online Garantie at the CHF 500 start-up rate (after reading the criteria PDF).
6. Review collection from the first order (Trustpilot or Trusted Shops) and wire `aggregateRating`; complete Product markup with brand/gtin/shipping/returns.
7. grow.de link request, 3-4 free directories, Hanfplatz free suggestion; one editorial pitch to Hanf Magazin.
8. `fr-CH` versions of the top category and box pages with correct hreflang.

## 5. Observations about jibbit.ch made in passing (not audited)

- [V] `https://jibbit.ch/` answered a header-less curl with a redirect to `/en`, and `robots.txt` advertises the sitemap as `http://` (not https) with 39 URLs. Googlebot sends no Accept-Language header, so it may be treated the same way. [U] whether this is the current production storefront or a legacy system; worth checking that the German version is what Google gets as default and that the sitemap URL is https.
- [V] First Wayback capture of jibbit.ch: 2022-06-27. The domain is not brand new, which helps slightly.

## 6. Method log

- Wayback CDX first-capture API for all domains (several needed retries because of 429s).
- curl with a desktop user agent for homepages, robots.txt, sitemap indexes and child sitemaps; URL counts are `<loc>` counts on 2026-09-20.
- `node tools/seo/probe-jsonld.mjs` on one papers-type product page per shop (Werners, Stayhigh, Tamar, Hemp Basement, Fourtwenty, Smokee); Der Hollaender and Breakshop taken from the earlier finding.
- Similarweb public pages via fetch + summariser; numbers are as extracted, dataset August 2026.
- Web searches were run from a US-based engine; used for discovering link sources and company facts, never for ranking claims.
- Nothing in either repository was modified apart from creating this file.
