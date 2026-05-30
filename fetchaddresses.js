require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBackfill() {
  console.log(`Connecting to: ${supabaseUrl}`);
  console.log("Fetching properties with missing addresses from database...");
  
  // 1. Get properties via the Supabase SQL RPC function
  const { data: properties, error } = await supabase.rpc('get_missing_addresses');

  if (error) {
    console.error("❌ Failed to fetch properties. Did you run the SQL function in Supabase?", error.message);
    return;
  }

  if (!properties || properties.length === 0) {
    console.log("✅ No properties found missing a street name or house number.");
    return;
  }

  console.log(`Found ${properties.length} properties to process. Beginning backfill...\n`);

  let successCount = 0;
  let errorCount = 0;

  // 2. Loop synchronously to respect Nominatim's strict rate limit
  for (const prop of properties) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${prop.lat}&lon=${prop.lng}&zoom=18&addressdetails=1`;

      // 3. Fetch from OpenStreetMap
      const response = await fetch(url, {
        headers: {
          // ⚠️ REPLACE THIS WITH YOUR REAL EMAIL OR YOU WILL GET A 403 ERROR ⚠️
          'User-Agent': 'GarupeMow-Backfill/1.0 (aksel.enter@gmail.com)' 
        }
      });

      if (!response.ok) {
        throw new Error(`Nominatim API responded with status: ${response.status}`);
      }

      const data = await response.json();
      const address = data.address || {};
      
      const streetName = address.road || address.street || address.pedestrian || null;
      const houseNumber = address.house_number || address.housenumber || null;

      // 4. Update the record in Supabase
      if (streetName || houseNumber) {
        const updatePayload = {};
        if (streetName) updatePayload.street_name = streetName;
        if (houseNumber) updatePayload.house_number = houseNumber;

        const { error: updateError } = await supabase
          .from('properties')
          .update(updatePayload)
          .eq('id', prop.id);

        if (updateError) {
          console.error(`❌ [${prop.id}] Failed to update DB:`, updateError.message);
          errorCount++;
        } else {
          console.log(`✅ [${prop.id}] Updated: ${streetName || ''} ${houseNumber || ''}`);
          successCount++;
        }
      } else {
         console.log(`⚠️ [${prop.id}] No street/house found at coordinates (${prop.lat.toFixed(4)}, ${prop.lng.toFixed(4)}).`);
      }

    } catch (err) {
      console.error(`❌ [${prop.id}] Error processing property:`, err.message);
      errorCount++;
    }

    // 5. CRITICAL: Wait 1.1 seconds before the next loop to prevent IP ban
    await sleep(1100); 
  }

  console.log("\n================ BACKFILL COMPLETE ================");
  console.log(`✅ Successfully updated: ${successCount}`);
  if (errorCount > 0) console.log(`❌ Errors encountered: ${errorCount}`);
  console.log("===================================================");
}

runBackfill();