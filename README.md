# CCPL Operations System (Firebase)

The UI and operating logic are **CCPL_Inventory_V5.html**, kept the same. Only two technical changes were made:
- **Firebase replaces Supabase + localStorage**, so data is shared live between all users.
- There is a **sign-in** screen for the approved CCPL emails.

## Files

- `index.html`: the V5 screens and CSS, plus a Masters screen and a sign-in screen
- `src/main.js`: the V5 logic, saved to Firestore with transactions
- `firestore.rules`: the database security rules
- `scripts/provision-users.js`: creates the 5 login accounts. It needs `service-account.json`, which is not included and must never be committed.

## Added on top of V5

1. **Masters tab (⚙)**
   - Add suppliers.
   - Add products with density (kg/L).
   - Add packaging materials, each with a **standard packing capacity**:
     - *Container* (bottle / can): capacity per piece in L or kg, and pieces per box. Example: 2.5 L × 4 = 10 L per box; 5 L × 2 = 10 L per box.
     - *Box accessory* (box / plate / thermocol): quantity used per box.
2. **Inward form**: "＋ Add new supplier…" and "＋ Add new product…" at the bottom of the dropdowns.
3. **Ready to Dispatch**
   - Choose the **Material in Box** (IPA, Acetone, Methanol, Acetonitrile, DCM or any added product). The material does not need an inward first.
   - Choose the **Batch No.** and the **Packing Standard** (container).
   - The preview shows litres and kg per box and in total, and the packaging consumed (container + every accessory).
4. **Dispatch** shows the material, units, **total litres** and **≈ kg** (litres × density, for knowledge only).
5. **Total Sold / Dispatched** card (Home + Packaging): all-time litres, ≈ kg and boxes, split by material.

The rest is exactly as in V5: inward (Drums / IBC / Tanker / Other), Kanta, reconciliation, GRN, packaging inward, ready queue with Edit Ready Qty, dispatch and register. The ↻ button is now **admin-only** and asks you to type `RESET`. It clears operational data and keeps the masters.

## Deploy

1. `firebase deploy --only firestore:rules`. Do this first: the new collections need these rules.
2. Vercel uses the same settings as before: Vite, `npm run build`, output `dist`. Set the six `VITE_FIREBASE_*` environment variables.
3. Local: `npm install`, then `npm run dev`.

On the first login, the default suppliers, the 5 chemicals and the 4 packaging items (2.5 L Bottle 4/box, Empty Box 1, Box Plate 2, Thermocol 2) are created automatically. Packaging stock from the old app (`stock/current`) is carried over once.

## Firestore (`companies/ccpl/…`)

`suppliers`, `products`, `packMaterials`, `inwards`, `readyBatches`, `packTxns` (packaging register), `stock/packaging` (Nos. per item), `stock/totals` (litres / kg sold), `counters/main` (INW / GRN numbers), `users`.
