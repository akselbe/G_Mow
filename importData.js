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
  
  // 1. Pre-filter the data: remove properties larger than 20,000 sqm (2 hectares)
  const validFeatures = geojson.features.filter(feature => {
    const area = Math.round(feature.properties.AREA_SCALE || 0);
    return area > 0 && area <= 20000;
  });

  const skippedCount = geojson.features.length - validFeatures.length;

  console.log(`Found ${geojson.features.length} total features.`);
  console.log(`Skipping ${skippedCount} massive properties (>2ha).`);
  console.log(`Starting upload for ${validFeatures.length} valid properties...`);

  let successCount = 0;
  let errorCount = 0;

  // Upload in smaller batches to avoid overloading the database
  const BATCH_SIZE = 50; 
  
  for (let i = 0; i < validFeatures.length; i += BATCH_SIZE) {
    const batch = validFeatures.slice(i, i + BATCH_SIZE);
    
    // 2. Map the JSON data perfectly to our new Supabase table schema
    const rowsToInsert = batch.map(feature => ({
      cadastre_number: feature.properties.CODE,
      area_sqm: Math.round(feature.properties.AREA_SCALE),
      geom: feature.geometry,
      
      // CRM Fields ready for you to fill out in the app later
      street_name: null,
      client_name: null,
      phone: null,
      email: null,
      mowing_price: null,
      
      // System States
      is_archived: false
    }));

    const { error } = await supabase.from('properties').insert(rowsToInsert);

    if (error) {
      console.error(`❌ Batch error near index ${i}:`, error.message);
      errorCount += batch.length;
    } else {
      successCount += batch.length;
      console.log(`✅ Uploaded ${successCount} / ${validFeatures.length} properties...`);
    }
  }

  console.log("\n================ IMPORT COMPLETE ================");
  console.log(`✅ Successfully inserted: ${successCount}`);
  console.log(`🚫 Skipped (>2ha): ${skippedCount}`);
  if (errorCount > 0) console.log(`❌ Failed to insert: ${errorCount}`);
  console.log("=================================================");
}

startImport();