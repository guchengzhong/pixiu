#!/usr/bin/env python3
import json, sys, urllib.request

url = "https://wttr.in/Wuhan?format=j1"
with urllib.request.urlopen(url) as resp:
    data = json.load(resp)

for day in data.get("weather", []):
    if day.get("date") == "2026-06-13":
        print(f"🌤️  武汉 (Wuhan) 天气预报")
        print(f"📅 日期: {day['date']}")
        print(f"🌅 日出: {day.get('astronomy', [{}])[0].get('sunrise', 'N/A')}")
        print(f"🌇 日落: {day.get('astronomy', [{}])[0].get('sunset', 'N/A')}")
        print(f"🌡️  最高温: {day.get('maxtempC', 'N/A')}°C")
        print(f"🌡️  最低温: {day.get('mintempC', 'N/A')}°C")
        print(f"💧 平均湿度: {day.get('avghumidity', 'N/A')}%")
        print()
        print("⏰ 逐时预报:")
        for slot in day.get("hourly", []):
            time_str = slot.get("time", "")
            t = f"{int(time_str)//100:02d}:{int(time_str)%100:02d}" if time_str else "N/A"
            desc = slot.get("weatherDesc", [{}])[0].get("value", "N/A")
            temp = slot.get("tempC", "N/A")
            hum = slot.get("humidity", "N/A")
            wind = slot.get("windspeedKmph", "N/A")
            print(f"   {t}  {desc}  {temp}°C  湿度{hum}%  风速{wind}km/h")
        sys.exit(0)

print("未找到 2026-06-13 的天气数据")
print(f"可用的日期: {[d.get('date') for d in data.get('weather', [])]}")