/**
 * Seeds the catalogue of vehicle and fuel types used by the driver app's
 * vehicle-details registration form. Idempotent: existing records (matched
 * by `code`) are updated, new ones inserted. Won't delete anything an
 * admin has added manually.
 *
 * Run with:  npx ts-node src/scripts/seedVehicleTypes.ts
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { config } from '../config';
import { VehicleType, FuelType } from '../models';

dotenv.config();

interface SeedItem {
  name: string;
  code: string;
  description?: string;
  sortOrder: number;
}

const VEHICLE_TYPES: SeedItem[] = [
  { name: '2 Wheeler', code: '2-wheeler', description: 'Bike / scooter', sortOrder: 10 },
  { name: '3 Wheeler', code: '3-wheeler', description: 'Auto rickshaw / tuk-tuk', sortOrder: 20 },
  { name: 'Hatchback', code: 'hatchback', description: 'Compact 5-seater (e.g. Swift, i20)', sortOrder: 30 },
  { name: 'Sedan', code: 'sedan', description: 'Standard 4-door 5-seater (e.g. City, Verna)', sortOrder: 40 },
  { name: 'SUV', code: 'suv', description: 'Sport utility vehicle, 5–7 seater', sortOrder: 50 },
  { name: 'MUV', code: 'muv', description: 'Multi-utility / 6–7 seater (e.g. Ertiga, Innova)', sortOrder: 60 },
  { name: 'Premium Sedan', code: 'premium-sedan', description: 'Luxury sedans for private rides', sortOrder: 70 },
  { name: 'Premium SUV', code: 'premium-suv', description: 'Luxury SUVs for private rides', sortOrder: 80 },
  { name: 'Mini Truck', code: 'mini-truck', description: 'Light goods carrier', sortOrder: 90 },
  { name: 'Tempo Traveller', code: 'tempo-traveller', description: '12–17 seater for shuttle / scheduled rides', sortOrder: 100 },
];

const FUEL_TYPES: SeedItem[] = [
  { name: 'Petrol', code: 'petrol', sortOrder: 10 },
  { name: 'Diesel', code: 'diesel', sortOrder: 20 },
  { name: 'CNG', code: 'cng', description: 'Compressed natural gas', sortOrder: 30 },
  { name: 'LPG', code: 'lpg', description: 'Liquefied petroleum gas', sortOrder: 40 },
  { name: 'Electric', code: 'electric', description: 'Battery-electric vehicle (BEV)', sortOrder: 50 },
  { name: 'Hybrid', code: 'hybrid', description: 'Petrol + electric hybrid', sortOrder: 60 },
];

async function upsertMany<T extends typeof VehicleType | typeof FuelType>(
  Model: T,
  items: SeedItem[],
  label: string,
): Promise<void> {
  let inserted = 0;
  let updated = 0;
  for (const item of items) {
    const existing = await (Model as any).findOne({ code: item.code });
    if (existing) {
      // Don't override admin-edited fields like isActive / display name —
      // only fill in missing description / sortOrder if absent.
      let touched = false;
      if (!existing.description && item.description) {
        existing.description = item.description;
        touched = true;
      }
      if (existing.sortOrder == null) {
        existing.sortOrder = item.sortOrder;
        touched = true;
      }
      if (touched) {
        await existing.save();
        updated++;
      }
    } else {
      await (Model as any).create({
        ...item,
        isActive: true,
      });
      inserted++;
    }
  }
  console.log(`[seed:${label}] inserted=${inserted} updated=${updated} total=${items.length}`);
}

async function run() {
  await mongoose.connect(config.mongo.uri);
  console.log(`[seed] connected to ${config.mongo.uri}`);

  await upsertMany(VehicleType, VEHICLE_TYPES, 'vehicle-types');
  await upsertMany(FuelType, FUEL_TYPES, 'fuel-types');

  console.log('[seed] done.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
