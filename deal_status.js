// Sälj-tratt: framåt-bara Deal-status. Rank avgör progression; en deal nedgraderas aldrig.
// Kundkontakt/Delegerad = 1 (start/sidospår), Offert = 2, Avtal = 3, Avslutad = 4.
// Används av _advanceDealStatus i index.js (offert signeras / abonnemang skapas → "Avtal").
export const DEAL_STATUS_RANK = { "Kundkontakt": 1, "Delegerad": 1, "Offert": 2, "Avtal": 3, "Avslutad": 4 };

// Ska en deal med nuvarande status flyttas till target? Bara om target ligger STRIKT längre
// fram i tratten (så "Avtal"/"Avslutad" aldrig nedgraderas, och samma status ej patchas i onödan).
// Okänt/tomt nuvarande = rank 0 → alla giltiga target går framåt. Ogiltigt target = false.
export function shouldAdvanceDealStatus(current, target) {
  const t = DEAL_STATUS_RANK[target] || 0;
  if (!t) return false;
  const c = DEAL_STATUS_RANK[String(current == null ? "" : current).trim()] || 0;
  return t > c;
}
