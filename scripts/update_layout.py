#!/usr/bin/env python3
# -*- coding: utf-8 -*-

with open('dashboard.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Satırları bul
start_line = None
end_line = None

for i in range(len(lines)):
    if 'Alarm Sekmeler' in lines[i]:
        start_line = i
    if start_line is not None and 'Bu sekme farklı bir amaçla kullanılacaktır' in lines[i]:
        end_line = i + 1
        break

if start_line is not None and end_line is not None:
    print(f"Başlangıç: {start_line+1}, Son: {end_line}")
    
    # Yeni HTML
    new_html = '''                    <!-- İki Container Sağlı Sollu -->
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
                    </div>
'''
    
    # Satırları değiştir
    lines = lines[:start_line] + [new_html] + lines[end_line:]
    
    with open('dashboard.html', 'w', encoding='utf-8') as f:
        f.writelines(lines)
    
    print("✅ Değişiklik başarılı!")
else:
    print("❌ Satırlar bulunamadı")
