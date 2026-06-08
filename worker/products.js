// products.js — the Radiant product catalog.
// JS port of C:\Radiant_License\products.py. Keep the IDs identical to
// that file: the ids are baked into issued license keys.

// [product_id, friendly_name] — order here is the order shown in the UI.
export const RADIANT_PRODUCTS = [
  ["quikqa", "QuikQA"],
  ["quikbolus", "QuikBolus"],
  ["quikcalc", "QuikCalc"],
  ["quikshare", "QuikShare"],
  ["quikshield", "QuikShield"],
  ["quikref", "QuikRef"],
  ["quikcare", "QuikCare"],
  ["quiklog", "QuikLog"],
  ["quikram", "QuikRAM"],
  ["quikprep", "QuikPrep"],
  ["quikflow", "QuikFlow"],
  ["quikpay", "QuikPay"],
  // QuikDose / QuikScript are coming later — add them here when ready.
];

export const PRODUCT_IDS = RADIANT_PRODUCTS.map(([id]) => id);
export const PRODUCT_NAMES = Object.fromEntries(RADIANT_PRODUCTS);
