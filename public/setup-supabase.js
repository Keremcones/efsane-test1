// Supabase Configuration Helper
// Browser console'da kullan: setSupabaseKey('YOUR_KEY_HERE')

function setSupabaseKey(anonKey) {
    if (!anonKey || anonKey.length < 10) {
        console.error('❌ Geçersiz key! Supabase dashboard\'tan al');
        return;
    }
    
    // localStorage'a kaydet
    localStorage.setItem('SUPABASE_ANON_KEY', anonKey);
    console.log('✅ Supabase ANON_KEY kaydedildi!');
    console.log('📝 Key:', anonKey.substring(0, 20) + '...');
    console.log('🔄 Sayfayı refresh et (Cmd+R)');
    
    // Otomatik refresh (opsiyonel)
    setTimeout(() => {
        console.log('⏳ 3 saniye sonra sayfa yenilenecek...');
    }, 1000);
}

// Kullanım:
// 1. Supabase Dashboard → Settings → API → anon (public) key'i kopyala
// 2. Console'a yapıştır:
//    setSupabaseKey('eyJhbGc...')
// 3. Enter tuşuna bas
// 4. Sayfa otomatik refresh olacak

console.log('💡 TİP: setSupabaseKey("YOUR_ANON_KEY_HERE") yapıştır');
