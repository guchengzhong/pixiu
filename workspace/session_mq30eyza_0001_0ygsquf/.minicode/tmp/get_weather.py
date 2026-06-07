#!/usr/bin/env python3
import sys
import json
import urllib.request
import time

# 设置编码
sys.stdout.reconfigure(encoding='utf-8')

def get_weather():
    try:
        # 获取当前时间
        current_time = time.strftime("%Y年%m月%d日 %H:%M:%S")
        
        # 获取天气信息
        url = "https://wttr.in/%E6%AD%A6%E6%B1%89%E6%B4%AA%E5%B1%B1%E5%8C%BA?format=j1"
        headers = {'User-Agent': 'Mozilla/5.0'}
        req = urllib.request.Request(url, headers=headers)
        
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            
            return data, current_time
            
    except Exception as e:
        print(f"获取天气信息失败: {e}")
        sys.exit(1)

if __name__ == "__main__":
    weather_data, query_time = get_weather()
    
    # 提取当前天气信息
    current_condition = weather_data['current_condition'][0]
    area = weather_data['nearest_area'][0]['areaName'][0]['value']
    
    print(f"=" * 50)
    print(f"查询时间: {query_time}")
    print(f"地点: 武汉市洪山区 (API返回: {area})")
    print(f"=" * 50)
    
    print(f"\n📊 【当前天气状况】")
    print(f"  天气: {current_condition['weatherDesc'][0]['value']}")
    print(f"  温度: {current_condition['temp_C']}°C (体感温度: {current_condition['FeelsLikeC']}°C)")
    print(f"  湿度: {current_condition['humidity']}%")
    print(f"  风向: {current_condition['winddir16Point']}")
    print(f"  风速: {current_condition['windspeedKmph']} km/h")
    print(f"  能见度: {current_condition['visibility']} km")
    print(f"  降水量: {current_condition['precipMM']} mm")
    print(f"  气压: {current_condition['pressure']} hPa")
    print(f"  云量: {current_condition['cloudcover']}%")
    
    # 提取今日天气预报
    if 'weather' in weather_data:
        today = weather_data['weather'][0]
        print(f"\n📅 【今日】{today['date']}")
        
        if 'hourly' in today and len(today['hourly']) >= 2:
            morning = today['hourly'][2]  # 上午时段
            afternoon = today['hourly'][4]  # 下午时段
            evening = today['hourly'][6]  # 晚上时段
            
            print(f"\n  🔹 今日天气预报:")
            print(f"    上午 ({morning['time']}): {morning['weatherDesc'][0]['value']}, {morning['tempC']}°C")
            print(f"    下午 ({afternoon['time']}): {afternoon['weatherDesc'][0]['value']}, {afternoon['tempC']}°C")
            print(f"    晚上 ({evening['time']}): {evening['weatherDesc'][0]['value']}, {evening['tempC']}°C")
            
            # 温度范围
            min_temp = today['mintempC']
            max_temp = today['maxtempC']
            print(f"    温度范围: {min_temp}°C ~ {max_temp}°C")
            
            # 日出日落
            if 'astronomy' in today and len(today['astronomy']) > 0:
                sunrise = today['astronomy'][0]['sunrise']
                sunset = today['astronomy'][0]['sunset']
                moon_phase = today['astronomy'][0]['moon_phase']
                print(f"    日出: {sunrise}, 日落: {sunset}")
                print(f"    月相: {moon_phase}")
    
    # 数据来源
    print(f"\nℹ️  数据来源: wttr.in")
    update_time = current_condition.get('localObsDateTime') if isinstance(current_condition, dict) else None
    print(f"  更新时间: {update_time or '实时数据'}")