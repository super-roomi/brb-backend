// The one service every barbershop is guaranteed to offer. It is auto-created
// with each shop (see admin shop create + seed), protected from deletion (see
// admin shop patch), and is what the app's quick-booking flow preselects — so
// a customer can book the most common cut in a couple of taps without picking a
// service. Admins can still rename or reprice it per shop; the isStandard flag
// (not the name) is the stable identity.
export const STANDARD_SERVICE = {
  name: "Haircut & Beard Trim",
  nameAr: "قص شعر وتهذيب لحية",
  nameCkb: "قژبڕین و ڕێکخستنی ڕیش",
  durationMin: 45,
  // Default combo price (IQD); admins adjust per shop after creation.
  price: 20_000,
} as const;
