#!/usr/bin/env node

const https = require('https');

const SUPABASE_URL = 'https://jcrbhekrphxodxhkuzju.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function fetchSupabase(endpoint, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${SUPABASE_URL}/rest/v1${endpoint}`);
        
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                'apikey': SERVICE_ROLE_KEY
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        data: data ? JSON.parse(data) : data
                    });
                } catch (e) {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        data: data
                    });
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runDiagnostics() {
    console.log('🔍 SUPABASE DIAGNOSTICS\n');
    console.log(`URL: ${SUPABASE_URL}`);
    console.log(`Service Role Key: ${SERVICE_ROLE_KEY ? '✅ SET' : '❌ MISSING'}\n`);

    if (!SERVICE_ROLE_KEY) {
        console.log('⚠️ SERVICE_ROLE_KEY not set. Please export SUPABASE_SERVICE_ROLE_KEY');
        console.log('\nExample:');
        console.log('export SUPABASE_SERVICE_ROLE_KEY="your-key-here"');
        console.log('node supabase-diagnostics.js');
        process.exit(1);
    }

    try {
        // 1. Check tables
        console.log('📋 CHECKING TABLES...\n');
        const tablesResponse = await fetchSupabase('information_schema.tables?select=table_name,table_schema');
        
        if (tablesResponse.status === 200) {
            const tables = tablesResponse.data
                .filter(t => t.table_schema === 'public')
                .map(t => t.table_name);
            
            console.log(`✅ Tables found: ${tables.length}`);
            console.log(tables.map(t => `   - ${t}`).join('\n'));
            
            const requiredTables = ['alarms', 'user_settings'];
            const missing = requiredTables.filter(t => !tables.includes(t));
            if (missing.length > 0) {
                console.log(`\n❌ MISSING TABLES: ${missing.join(', ')}`);
            } else {
                console.log(`✅ All required tables present\n`);
            }
        } else {
            console.log(`❌ Failed to fetch tables: ${tablesResponse.status}`);
            console.log(tablesResponse.data);
        }

        // 2. Check alarms table structure
        if (tablesResponse.status === 200) {
            const tables = tablesResponse.data
                .filter(t => t.table_schema === 'public')
                .map(t => t.table_name);

            if (tables.includes('alarms')) {
                console.log('📊 ALARMS TABLE STRUCTURE:\n');
                const columnsResponse = await fetchSupabase(
                    `information_schema.columns?select=column_name,data_type,is_nullable&table_name=eq.alarms&table_schema=eq.public`
                );
                
                if (columnsResponse.status === 200) {
                    columnsResponse.data.forEach(col => {
                        const nullable = col.is_nullable === 'YES' ? '(nullable)' : '(not null)';
                        console.log(`   ${col.column_name}: ${col.data_type} ${nullable}`);
                    });
                    console.log('');
                } else {
                    console.log('❌ Failed to fetch columns\n');
                }
            }

            // 3. Check RLS status
            if (tables.includes('alarms')) {
                console.log('🔒 RLS STATUS:\n');
                const rlsResponse = await fetchSupabase(
                    `information_schema.tables?select=table_name,is_insertable_into&table_name=eq.alarms`
                );
                
                if (rlsResponse.status === 200 && rlsResponse.data.length > 0) {
                    console.log(`   alarms: RLS enabled`);
                } else {
                    console.log('   Could not determine RLS status');
                }
                console.log('');
            }

            // 4. Try to read alarms
            if (tables.includes('alarms')) {
                console.log('📈 ALARMS DATA:\n');
                const alarmsResponse = await fetchSupabase('/alarms?select=*&limit=5');
                
                if (alarmsResponse.status === 200) {
                    console.log(`✅ Alarms table accessible`);
                    console.log(`   Total records found: ${alarmsResponse.data.length}`);
                    if (alarmsResponse.data.length > 0) {
                        console.log(`   Sample record keys: ${Object.keys(alarmsResponse.data[0]).join(', ')}`);
                    }
                } else if (alarmsResponse.status === 401) {
                    console.log(`❌ Unauthorized (401) - Service Role Key issue`);
                } else {
                    console.log(`❌ Error: ${alarmsResponse.status}`);
                    console.log(alarmsResponse.data);
                }
                console.log('');
            }

            // 5. Check user_settings
            if (tables.includes('user_settings')) {
                console.log('👤 USER_SETTINGS TABLE:\n');
                const settingsResponse = await fetchSupabase('/user_settings?select=*&limit=5');
                
                if (settingsResponse.status === 200) {
                    console.log(`✅ user_settings accessible`);
                    console.log(`   Total records: ${settingsResponse.data.length}`);
                } else {
                    console.log(`❌ Error accessing user_settings: ${settingsResponse.status}`);
                }
                console.log('');
            } else {
                console.log('❌ user_settings table not found\n');
            }
        }

        console.log('✅ DIAGNOSTICS COMPLETE\n');
    } catch (error) {
        console.error('❌ ERROR:', error.message);
        process.exit(1);
    }
}

runDiagnostics();
