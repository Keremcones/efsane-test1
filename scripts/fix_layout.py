#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# Dosyayı oku
with open('dashboard.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Eski kısmı bul ve yeni kısımla değiştir
old_section = '''                    <!-- Alarm Sekmeler -->
                    <div style="display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid var(--border);">
                        <button class="alarm-tab active" id="activeTab" onclick="switchAlarmTab('active')" style="flex: 1; padding: 12px; background: none; border: none; color: var(--text-secondary); cursor: pointer; font-weight: 600; border-bottom: 2px solid transparent; transition: all 0.3s;">
                            🔔 Alarmlar
                        </button>
                        <button class="alarm-tab" id="closedTab" onclick="switchAlarmTab('closed')" style="flex: 1; padding: 12px; background: none; border: none; color: var(--text-secondary); cursor: pointer; font-weight: 600; border-bottom: 2px solid transparent; transition: all 0.3s;">
                            📡 Alarm Sinyalleri
                        </button>
                    </div>
                    
                    <!-- 🔔 Alarmlar Sekmesi -->
                    <div id="activeAlarmContainer" class="alarm-tab-content" style="display: block;">
                        <div class="alarm-grid" id="activeAlarmGrid">
                            <!-- Active alarms will be inserted here -->
                        </div>
                    </div>
                    
                    <!-- Alarm Sinyalleri Sekmesi -->
                    <div id="closedAlarmContainer" class="alarm-tab-content" style="display: none;">
                        <!-- Bu sekme farklı bir amaçla kullanılacaktır -->
                    </div>'''

new_section = '''                    <!-- İki Container Sağlı Sollu -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                        <!-- Sol: Alarmlar -->
                        <div>
                            <div style="font-weight: 600; margin-bottom: 12px; color: var(--accent);">🔔 Alarmlar</div>
                            <div class="alarm-grid" id="activeAlarmGrid">
                                <!-- Active alarms will be inserted here -->
                            </div>
                        </div>
                        
                        <!-- Sağ: Alarm Sinyalleri -->
                        <div>
                            <div style="font-weight: 600; margin-bottom: 12px; color: var(--accent);">📡 Alarm Sinyalleri</div>
                            <div id="closedAlarmContainer" style="min-height: 100px;">
                                <!-- Bu sekme farklı bir amaçla kullanılacaktır -->
                            </div>
                        </div>
                    </div>'''

if old_section in content:
    content = content.replace(old_section, new_section)
    with open('dashboard.html', 'w', encoding='utf-8') as f:
        f.write(content)
    print("✅ Değişiklik başarılı!")
else:
    print("❌ Eski kısım bulunamadı")
    # Debug: dosya boyutunu kontrol et
    print(f"Dosya boyutu: {len(content)} karakter")
