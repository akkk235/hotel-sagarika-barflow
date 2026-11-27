/**
 * Pricing rules for Hotel Sagarika BarFlow.
 *
 * Liquor is bought and stocked in sealed 180 ml bottles. The user enters the
 * selling price of a 180 ml bottle and every pour is priced proportionally:
 *
 *   serving price = (bottle price / 180) * serving size
 *
 * The result is rounded UP to the next multiple of ₹5. A price that is already
 * a multiple of ₹5 is left untouched (₹220 stays ₹220, it does not become ₹225).
 *
 * Beer is deliberately different: every bottle size (650/500/330 ml ...) is an
 * independent product variant with its own purchase price and selling price.
 * Beer prices are never derived proportionally from another size.
 */

export const BOTTLE_ML = 180;
export const POUR_SIZES = [30, 60, 90, 120, 150, 180];

/** Bottle sizes offered by default for a new beer product (admins may add more). */
export const BEER_DEFAULT_SIZES = [650, 500, 330];

const EPSILON = 1e-9;

/**
 * Round a rupee amount UP to the next multiple of 5.
 * Returns 0 for non-positive / non-finite input.
 */
export function roundUpToFive(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const paise = Math.round(value * 100) / 100;
  return Math.ceil((paise - EPSILON) / 5) * 5;
}

/** Exact proportional value before rounding, rounded to paise. */
export function rawServingPrice(bottlePrice, ml) {
  const price = Number(bottlePrice);
  const size = Number(ml);
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) return 0;
  return Math.round(((price / BOTTLE_ML) * size) * 100) / 100;
}

/** Selling price for one pour: proportional, then rounded up to a multiple of ₹5. */
export function liquorServingPrice(bottlePrice, ml) {
  return roundUpToFive(rawServingPrice(bottlePrice, ml));
}

export function pourLabel(ml) {
  return Number(ml) === BOTTLE_ML ? `${BOTTLE_ML} ml (full bottle)` : `${Number(ml)} ml`;
}

/**
 * Full price list for a 180 ml bottle price.
 * @returns {{ml:number,label:string,price:number,raw:number}[]}
 */
export function deriveLiquorPricing(bottlePrice) {
  return POUR_SIZES.map((ml) => ({
    ml,
    label: pourLabel(ml),
    price: liquorServingPrice(bottlePrice, ml),
    raw: rawServingPrice(bottlePrice, ml),
  }));
}

/** Beer size label, e.g. 650 -> "650 ml bottle". */
export function beerSizeLabel(ml) {
  const size = Number(ml);
  return Number.isFinite(size) && size > 0 ? `${size} ml bottle` : 'Bottle';
}

/**
 * Is this catalogue row a beer product? Beer rows carry stock_mode='variant'
 * (one stock balance per bottle size); liquor rows are unit_type='ml'.
 */
export function isVariantStockProduct(product) {
  return product?.stock_mode === 'variant';
}

/** A variant's own stock balance (beer sizes), falling back to the parent balance. */
export function variantStock(variant, product) {
  if (variant && variant.stock_qty != null) return Number(variant.stock_qty) || 0;
  return Number(product?.stock_qty) || 0;
}
