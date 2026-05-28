const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

// Supabase client expects the project base URL only (no /rest/v1 path)
function normalizeSupabaseUrl(raw) {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1\/?$/i, "");
}

const supabaseUrl = normalizeSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL || "");
const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ Error: Missing Supabase credentials in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function startImport() {
  console.log(`Connecting to: ${supabaseUrl}`);
  console.log("Reading Garupe_PropertyLines.json...");
  
  const rawData = fs.readFileSync('Garupe_PropertyLines.json', 'utf8');
  const geojson = JSON.parse(rawData);
  const features = geojson.features;
  
  console.log(`Found ${features.length} features. Starting upload...`);

  let successCount = 0;
  let errorCount = 0;

  // Upload in smaller batches to avoid overloading the database
  const BATCH_SIZE = 50; 
  
  for (let i = 0; i < features.length; i += BATCH_SIZE) {
    const batch = features.slice(i, i + BATCH_SIZE);
    
    // Supabase automatically converts standard GeoJSON geometry into PostGIS!
    const rowsToInsert = batch.map(feature => ({
      geom: feature.geometry, // The map shape
      client_name: null,      // Empty CRM fields ready for later
      phone: null,
      mowing_price: null,
      status: 'Lead'
    }));

    const { error } = await supabase.from('properties').insert(rowsToInsert);

    if (error) {
      console.error(`❌ Batch error near index ${i}:`, error.message);
      errorCount += batch.length;
    } else {
      successCount += batch.length;
      console.log(`✅ Uploaded ${successCount} / ${features.length} properties...`);
    }
  }

  console.log("\n================ IMPORT COMPLETE ================");
  console.log(`✅ Successfully inserted: ${successCount}`);
  if (errorCount > 0) console.log(`❌ Failed to insert: ${errorCount}`);
  console.log("=================================================");
}

startImport();